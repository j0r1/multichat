
class RTCCommunicator
{
    constructor() { }

    onIceCandidate(uuid, candStr) { }
    onConnected(uuid) { }
    onGeneratedOffer(uuid, offer) { }
    onGeneratedAnswer(uuid, answer) { }
    onStreamError(uuid, errStr) { }
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

    sendMessage(msg)
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
                this.sendMessage({"roomid": this.roomId, "displayname": this.name});
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
let localAudioStream = null;
let isDummyAudioStream = true;

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
    
    let audioTrack = localAudioStream.getAudioTracks()[0];
    pc.addTrack(audioTrack);

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

    try
    {
        let s = await navigator.mediaDevices.getUserMedia({video:false, audio:true});
        localAudioStream = s;
        isDummyAudioStream = false;

        // start muted
        let audioTrack = localAudioStream.getAudioTracks()[0];
        audioTrack.enabled = false;
    }
    catch(err)
    {
        vex.dialog.alert("Warning: no audio stream found, remotes will not hear you");
        document.getElementById("message").innerHTML = "No audio input available";

        // create a dummy stream

        //let audio = document.createElement("audio");
        let ctx = new AudioContext();
        //let src = ctx.createMediaElementSource(audio);
        let dest = ctx.createMediaStreamDestination();
        //src.connect(dest);
        localAudioStream = dest.stream;

        //audio.src = "soundfile.wav";
        //audio.play();
    }

    vid.srcObject = localStream;
    await vid.play();
}

function startLocalStream(displayName)
{
    return new Promise((resolve, reject) => {
        startLocalStreamAsync(displayName)
        .then(() => { resolve(); })
        .catch((err) => {
            removeStream(localStreamName);
            reject(err);
        })
    });
}

function getUserAndRoom()
{
    return new Promise((resolve, reject) => {

        const nameKey = "multichatDisplayName";
        const serverKey = "multichatServerURL";
        const roomKey = "multichatRoomID";

        let name = "JimminyBillyBob";
        let server = "ws://localhost:8888";
        let room = "ABC123";
        
        if (nameKey in localStorage)
            name = localStorage[nameKey];
        if (serverKey in localStorage)
            server = localStorage[serverKey];
        if (roomKey in localStorage)
            room = localStorage[roomKey];

        vex.dialog.open({
            message: "Specify your name, server URL, and room name",
            input: `
            <style>
                .vex-custom-field-wrapper {
                    margin: 1em 0;
                }
                .vex-custom-field-wrapper > label {
                    display: inline-block;
                    margin-bottom: .2em;
                }
            </style>
            <div class="vex-custom-field-wrapper">
                <label for="name">Name</label>
                <div class="vex-custom-input-wrapper">
                    <input id="input_name" name="name" type="text"/>
                </div>
            </div>
            <div class="vex-custom-field-wrapper">
                <label for="serverurl">Server URL</label>
                <div class="vex-custom-input-wrapper">
                    <input id="input_server" name="serverurl" type="text"/>
                </div>
            </div>
            <div class="vex-custom-field-wrapper">
                <label for="roomid">Room</label>
                <div class="vex-custom-input-wrapper">
                    <input id="input_room" name="roomid" type="text"/>
                </div>
            </div>`,
            afterOpen: function() {
                $("#input_name").val(name);
                $("#input_server").val(server);
                $("#input_room").val(room);
            },
            callback: function (data) {
                if (!data)
                {
                    reject(new Error("User cancelled"));
                    return;
                }

                let name = $("#input_name").val();
                let server = $("#input_server").val();
                let room = $("#input_room").val();
                localStorage[nameKey] = name;
                localStorage[serverKey] = server;
                localStorage[roomKey] = room;
                let obj = { "name": name, "roomid": room, "serverlurl": server };
                resolve(obj);
            }
        })
    });
}

async function main()
{
    vex.defaultOptions.className = 'vex-theme-wireframe';
    document.getElementById("message").style.display = "none";

    backupStream = await setupBackupStream();
    setInterval(periodicCheckWebCamAvailable, 1000);
    setInterval(periodicCheckMuteStatus);

    showButtons(true);

    roomConn.onFatalError = (err) => { 
        
        let msg = "" + err;
        if (err instanceof Event)
        {
            if (err.target instanceof WebSocket)
                msg = "Error in WebSocket connection";
            else
                msg = "Unknown error: " + err;
        }
        vex.dialog.alert(msg);

        console.log("FATAL ERROR");
        console.log(err);
    }

    roomConn.onUserJoined = (wsUuid, name, isSelf) => { 
        console.log(`User joined: ${wsUuid} ${name} ${isSelf}`);
        if (isSelf)
            console.log("It's us!");
        else
        {
            // let's just use the wsUuid to identify RTC streams as well
            startGenerateOffer(wsUuid, name);
        }
    }

    roomConn.onUserLeft = (wsUuid) => {
        console.log(`User left: ${wsUuid}`);
        removeStream(wsUuid);
    }

    roomConn.onP2PMessage = (msg) => {
        console.log("Got P2P message");
        console.log(msg);

        if ("offer" in msg)
        {
            startFromOffer(msg.source, msg.offer, msg.displayname);

            // TODO: buffered ICE candidates
        }
        else if ("answer" in msg)
        {
            processAnswer(msg.source, msg.answer);
        }
        else if ("ice" in msg)
        {
            // TODO: buffer if needed?

            addIceCandidate(msg.source, msg.ice);
        }
        else
            console.log("Unhandled message!");
    }

    communicator.onIceCandidate = (uuid, candStr) => {
        roomConn.sendMessage({ "destination": uuid, "ice": candStr});
    }

    communicator.onConnected = (uuid) => { console.log("Connection for " + uuid + " is connected!"); }
    communicator.onGeneratedOffer = (uuid, offer) => {
        roomConn.sendMessage({ "destination": uuid, "offer": offer});
    }
    
    communicator.onGeneratedAnswer = (uuid, answer) => {
        roomConn.sendMessage({ "destination": uuid, "answer": answer });
    }
    
    communicator.onStreamError = (uuid, errStr) => {
        vex.dialog.alert("Stream error for " + uuid + ": " + err);
    }

    let connInfo = await getUserAndRoom();
    await startLocalStream(connInfo.name);

    roomConn.open(connInfo.serverlurl, connInfo.roomid, connInfo.name);
}

function periodicCheckMuteStatus()
{
    if (!localStream) // we haven't really started yet
        return;

    let enabled = false;
    if (localAudioStream && !isDummyAudioStream)
    {
        let audioTrack = localAudioStream.getAudioTracks()[0];
        if (audioTrack.enabled)
            enabled = true;
    }

    if (enabled)
        document.getElementById("message").style.display = "none";
    else
        document.getElementById("message").style.display = "";
}

function toggleMute()
{
    if (!localAudioStream || isDummyAudioStream)
        return;
    
    let audioTrack = localAudioStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;

    periodicCheckMuteStatus();
}
