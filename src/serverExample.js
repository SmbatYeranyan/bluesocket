const BlueSocket = require("./index").BlueSockets;

const fireSock = new BlueSocket({
    logging: true, 
    port: parseInt(process.argv[2]),
    redis: {
        host: 'XXXXXX', // The redis's server ip 
        port: 'XXXX',
        auth_pass: 'XXX'
    }
});

fireSock.onEvents("connected", (event, ws) => {
    console.log("connected!!", event)
    fireSock.broadcastToSession("userConnected", event.eventBody, ws);
})

fireSock.onEvents("disconnected", (event, ws) => {
    console.log("disconnected!!", event)
    fireSock.broadcastToSession("userDisconnected", event.eventBody, ws)
})

fireSock.onEvents("newSyncLink", (event, ws) => {
    console.log("newSyncLink", event)
    fireSock.broadcastToSession("newSyncLink", event.eventBody, ws);
    fireSock.updateSessionMeta(ws, { url: event.eventBody.url })
})

fireSock.onEvents("joinSession", (event, ws) => {
    console.log("JOIN SESSION", event)
    fireSock.joinSession(event, ws)
    fireSock.broadcastToSession("userJoined", event.eventBody, ws);
    fireSock.getUsersInSession(event.eventBody.sessionId).then((users) => {
        console.log("users in session")
        console.log(users)
        fireSock.emitToSocket(ws, "usersInSession", users)
    })
})

fireSock.onEvents("leaveSession", (event, ws) => {
    console.log("JOIN SESSION", event)
    fireSock.leaveSession(event, ws)
})

