import FireSock from './webClient.js';
let fs = new FireSock();
fs.connect({ host: `ws://localhost:${process.argv[2]}`, reconnect: true }).then(() => {

});
fs.onEvent("connected", (event) => {
    console.log("connected!", event)
    fs.emit("joinSession", {
        sessionId: process.argv[3]
    });
});
fs.onEvent("sessionInfo", (event) => {
    console.log("sessionInfo!", JSON.stringify(event))

});
fs.onEvent("userJoined", (event) => {
    // console.log("USER JOINED!", event)
    // fs.emit("newSyncLink", {
    //     url: "newURLHTTPCODEHERE"
    // });
})
fs.onEvent("newSyncLink", (event) => {
    console.log("new SyncLink", event)

})
fs.onEvent("usersInSession", (event) => {
    console.log("usersInSession", event)

})

setTimeout(() => {

}, 3000)

setTimeout(() => {

}, 5000)