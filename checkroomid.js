
const allowedCharactersInRoomId = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function checkRoomId(roomId)
{
    if (roomId.length < 6)
        throw "Expecting a string of at least length 6";
    if (roomId.length > 128)
        throw "Expecting a string of at most 128 characters";
    for (let c of roomId)
    {
        if (allowedCharactersInRoomId.indexOf(c) < 0)
            throw `Character '${c}' is not allowed in room ID`;
    }
}

