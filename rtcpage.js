
class RTCCommunicator
{
    constructor()
    {
    }

    onIceCandidate(uuid, candStr)
    {
    }

    onConnected(uuid)
    {
    }

    onGeneratedOffer(uuid, offer)
    {
    }

    onGeneratedAnswer(uuid, answer)
    {
    }

    onStreamError(uuid, errStr)
    {
    }

    onLocalStreamStarted()
    {
    }

    onLocalStreamError(errStr)
    {
    }
}

class RoomConnection
{
    constructor()
    {
        this.ws = null;
        this.wsUuid = null;
        this.roomId = null;
        this.name = null;
    }

    getOwnUuid() { return this.wsUuid; }

    open(url, room, name)
    {
        if (this.ws)
            throw new Error("WebSocket already exists");

        this.roomId = room;
        this.name = name;

        try
        {
            let ws = new WebSocket(url);
            this.ws = ws;

            ws.onopen = () => console.log("WebSocket connection opened");
            ws.onmessage = (evt) => this._onWsMessage(evt.data);
            ws.onerror = (err) => this._onError(err);
            ws.onclose = () => this._onError(new Error("Connection closed unexpectedly"));
        }
        catch(err)
        {
            setTimeout(() => this._onError(err), 0);
        }
    }

    onFatalError(err) { } // TODO: override

    onUserJoined(uuid, displayName, isSelf) { } // TODO: override

    onUserLeft(uuid) { }

    onP2PMessage(msg) { }

    _cleanupWebSocket()
    {
        if (this.ws)
        {
            let ws = this.ws;
            this.ws = null;
            ws.onopen = null; // TODO: use actual functions?
            ws.onmessage = null;
            ws.onerror = null;
            ws.onclose = null;
        }
    }

    _sendMessage(msg)
    {
        try
        {
            let s = JSON.stringify(msg);
            this.ws.send(s);
        }
        catch(err)
        {
            setTimeout(() => this._onError(err), 0);
        }
    }

    _onWsMessage(msg)
    {
        let obj = null;
        try
        {
            obj = JSON.parse(msg);
        }
        catch(err)
        {
            setTimeout(() => this._onError(err), 0);
            return;
        }

        console.log("Received message");
        console.log(obj);
        if ("uuid" in obj)
        {
            if (this.wsUuid !== null)
                this._onError(new Error("Received 'uuid' message, but uuid is already set"));
            else
            {
                this.wsUuid = obj["uuid"];

                // Send out room and name message
                this._sendMessage({"roomid": this.roomId, "displayname": this.name});
            }
        }
        else
        {
            if ("userjoined" in obj)
            {
                this.onUserJoined(obj["userjoined"], obj["displayname"], obj["userjoined"] === this.wsUuid);
            }
            else if ("userleft" in obj)
            {
                this.onUserLeft(obj["userleft"]);
            }
            else if ("source" in obj)
            {
                this.onP2PMessage(obj)
            }
            else
                this._onError(new Error("Can't handle received message: " + msg));
        }
    }

    _onError(err)
    {
        console.log("Received error:");
        console.log(err);

        this._cleanupWebSocket();
        this.onFatalError(err);
    }
}


let roomConn = new RoomConnection();
let communicator = new RTCCommunicator(); // TODO

const localStreamName = "LOCALSTREAM";
let localStream = null;
let backupStream = null;
let webcamIndex = -1;

const pcConfig = {"iceServers": [{"url": "stun:stun.l.google.com:19302"}]};
let peerConnections = { };

function periodicCheckWebCamAvailable()
{
    // Only change when using backup stream as failsafe
    if (webcamIndex >= 0 || backupStream === null || localStream === null || localStream !== backupStream)
        return;
    
    navigator.mediaDevices.getUserMedia({video:true, audio:false}).then((s) => {
        setLocalStream(s, 1); // 0 is the backup stream
    }).catch((err) => {
        // console.log("Can't get webcam: " + err);
    })
}

function setLocalStream(s, idx)
{
    if (localStream && localStream != backupStream)
    {
        localStream.oninactive = null;
        const tracks = localStream.getTracks();
        tracks.forEach((track) => track.stop());
    }
    localStream = s;
    if (s != backupStream)
        localStream.oninactive = switchToBackupStream;

    webcamIndex = idx;
    updateNewLocalStream();
}

function toggleNextWebCam()
{
    let videoDevs = [ "backupstream" ];

    navigator.mediaDevices.enumerateDevices()
    .then((devices) => {
        devices.forEach((device) => {
            if (device.kind == "videoinput")
                videoDevs.push(device);
        });

        if (videoDevs.length > 0)
        {
            let newWebcamIndex = (webcamIndex + 1)%videoDevs.length;
            console.log(`newWebcamIndex = ${newWebcamIndex}, webcamIndex = ${webcamIndex}`);
            if (newWebcamIndex != webcamIndex)
            {
                if (videoDevs[newWebcamIndex] === "backupstream")
                {
                    setLocalStream(backupStream, 0);
                }
                else
                {
                    let deviceId = videoDevs[newWebcamIndex].deviceId;
                    console.log(videoDevs[newWebcamIndex].label);
                    navigator.mediaDevices.getUserMedia({video:{deviceId: deviceId}, audio:false }).then((s) => {
                        setLocalStream(s, newWebcamIndex);
                    }).catch((err) => {
                        console.log("Can't get webcam: " + err);
                        setLocalStream(backupStream, newWebcamIndex); // use as failsafe so we don't get stuck
                    })
                }
            }
        }
    })
}

function updateNewLocalStream()
{
    let vid = document.getElementById(localStreamName);
    
    vid.srcObject = localStream;
    // vid.play(); // Actually returns a promise, but not needed because of autoplay

    let videoTrack = localStream.getVideoTracks()[0];

    for (let uuid in peerConnections)
    {
        let pc = peerConnections[uuid];

        let sender = pc.getSenders().find(function(s) {
            return s.track.kind == videoTrack.kind;
          });

        if (sender)
            sender.replaceTrack(videoTrack);
    }
}

function switchToBackupStream()
{
    console.log("Stream lost, switching to backup stream");
    setLocalStream(backupStream, -1);
}

function setupBackupStream()
{
    return new Promise((resolve, reject) => {
        let img = new Image();
        img.src = "testscreen.png";
        img.onload = () => {

            let cnvs = document.createElement("canvas");
            cnvs.width = img.width;
            cnvs.height = img.height;
            
            setInterval(() => {
                let ctx = cnvs.getContext("2d");
                ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, cnvs.width, cnvs.height);    
            }, 1000);
            // document.body.appendChild(cnvs);

            let s = cnvs.captureStream(1.0);
            resolve(s);
        }
        img.onerror = (err) => {
            reject("Error loading test screen image: " + err);
        }
    })
}

function removeStream(uuid)
{
    // TODO: what if the local stream/webcam is specified? Ignore? Do something else?
    // It may still be used in the rest of the peerconnections!

    // Cleanup peerConnections entry
    if (uuid in peerConnections)
    {
        let pc = peerConnections[uuid];
        delete peerConnections[uuid];

        pc.onicecandidate = null;
        pc.ontrack = null;
    }

    removeVideo(uuid);
}

function newPeerConnectionCommon(uuid, displayName)
{
    if (!localStream || localStream.getVideoTracks().length == 0)
        throw "No local video stream available";

    let pc = new RTCPeerConnection(pcConfig);
    peerConnections[uuid] = pc;

    let vid = createVideoElement(uuid, displayName);
    
    let videoTrack = localStream.getVideoTracks()[0];
    pc.addTrack(videoTrack); // This is our own video
    
    // This should be the remote video (or audio in case that's enabled)
    pc.ontrack = (evt) => {

        if (!vid.srcObject)
            vid.srcObject =  new MediaStream();

        vid.srcObject.addTrack(evt.track);
        // vid.play(); // Actually returns a promise, but not needed because of autoplay
    }

    pc.onicecandidate = (evt) => { 
        communicator.onIceCandidate(uuid, JSON.stringify(evt.candidate));
    }

    pc.oniceconnectionstatechange = () => {
        if (pc.iceConnectionState == "connected")
            communicator.onConnected(uuid);
    }

    return pc;
}

async function startFromOfferAsync(uuid, offerStr, displayName)
{
    let pc = newPeerConnectionCommon(uuid, displayName);

    let offer = new RTCSessionDescription(JSON.parse(offerStr));
    await pc.setRemoteDescription(offer);

    let answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    return JSON.stringify(answer);
}

async function startGenerateOfferAsync(uuid, displayName)
{
    let pc = newPeerConnectionCommon(uuid, displayName);
        
    let offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    return JSON.stringify(offer);
}

function startGenerateOffer(uuid, displayName)
{
    startGenerateOfferAsync(uuid, displayName)
    .then((offer) =>  communicator.onGeneratedOffer(uuid, offer))
    .catch((err) => {
        removeStream(uuid);
        communicator.onStreamError(uuid, "" + err);
        return;
    })
}

function startFromOffer(uuid, offerStr, displayName)
{
    startFromOfferAsync(uuid, offerStr, displayName)
    .then((answer) => {
        communicator.onGeneratedAnswer(uuid, answer)
    })
    .catch((err) => {
        removeStream(uuid);
        communicator.onStreamError(uuid, "" + err);
        return;
    })
}

async function processAnswerAsync(uuid, answerStr)
{
    if (!(uuid in peerConnections)) // TODO: report this somehow?
    {
        console.warn("processAnswer: uuid " + uuid + " not found");
        return;
    }

    let answer = new RTCSessionDescription(JSON.parse(answerStr));
    let pc = peerConnections[uuid];
    await pc.setRemoteDescription(answer);  
}

function processAnswer(uuid, answerStr)
{
    processAnswerAsync(uuid, answerStr)
    .then((answer) => {
        console.log("Processed answer!"); // TODO: more feedback?    
    })
    .catch((err) => {
        removeStream(uuid);
        communicator.onStreamError(uuid, "" + err);
        return;
    })
}

function addIceCandidate(uuid, candidateStr)
{
    if (!(uuid in peerConnections))
    {
        console.warn("addIceCandidate: uuid " + uuid + " not found in peerconnection table");
        return;
    }

    let pc = peerConnections[uuid];
    let candidate = JSON.parse(candidateStr);
    if (candidate)
        pc.addIceCandidate(candidate);
}

async function startLocalStreamAsync(displayName)
{
    if (localStream)
        throw "Local stream already exists";

    let vid = createVideoElement(localStreamName, displayName);

    try
    {
        let s = await navigator.mediaDevices.getUserMedia({video:true, audio:false});
        setLocalStream(s, 1); // 0 is the backup stream
    }
    catch(err)
    {
        console.warn("Error getting local webcam stream: " + err);
        setLocalStream(backupStream, -1);
    }

    vid.srcObject = localStream;
    // vid.play(); // Actually returns a promise, but not needed because of autoplay
}

function startLocalStream(displayName)
{
    startLocalStreamAsync(displayName)
    .then(() => communicator.onLocalStreamStarted())
    .catch((err) => {
        removeStream(localStreamName);
        communicator.onLocalStreamError("" + err);
    })
}

async function main()
{
    backupStream = await setupBackupStream();
    setInterval(periodicCheckWebCamAvailable, 1000);

    showButtons(false);

    roomConn.onFatalError = (err) => { console.log("FATAL ERROR"); console.log(err); }
    roomConn.onUserJoined = (wsUuid, name, isSelf) => { console.log(`User joined: ${wsUuid} ${name} ${isSelf}`); }
    roomConn.onUserLeft = (wsUuid) => console.log(`User left: ${wsUuid}`);
    roomConn.onP2PMessage = (msg) => { console.log("Got P2P message"); console.log(msg); }
    roomConn.open("ws://localhost:8888", "ABC123", "Me");
}

