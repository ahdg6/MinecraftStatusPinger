import packetGen from "./packetGenerator.js"
import packetDec from "./packetDecoder.js"
import * as net from "net";
import { Packet, ServerStatusOptions, ServerStatus } from "./types.js";

import { promises as dns } from 'dns';


/**
 * Looks up the server.
 * @example
 * Here's a simple example:
 * ```
 * let result = await mc.lookup("mc.hypixel.net", {
 *    port: 25565,
 *    ping: true,
 *    timeout: 10000,
 *    throwOnParseError: false,
 *    disableSRV: false
 * })
 * ```
 */

async function lookup(options?: ServerStatusOptions): Promise<ServerStatus> {
    return new Promise<ServerStatus>(async (resolve, reject) => {
 
        let hostname = options.host || options.hostname;
        if(!hostname) throw new Error("No hostname was provided!")

        let port = options.port != null ? options.port : 25565;
        let timeout = options.timeout != null ? options.timeout : 10000;
        let ping = options.ping != null ? options.ping : true;
        let throwOnParseError = options.throwOnParseError != null ? options.throwOnParseError : true;
        let disableSRV = options.disableSRV != null ? options.disableSRV : false;
        let disableJSONParse = options.disableJSONParse != null ? options.disableJSONParse : false;
        if (!disableSRV) ({ hostname, port } = await processSRV(hostname, port))
        // Default port of 25565, default timeout of 10 seconds.
        // Ping is sent by default. 

        let portal = net.createConnection({ port: port, host: hostname, lookup: customLookup }, async () => {
            // Send first the handshake, and then the status request to the server.
            let handshake = await packetGen.craftHandshake(hostname, port);
            let statusRequest = await packetGen.craftEmptyPacket(0);
            portal.write(handshake);
            portal.write(statusRequest);
        })

        let packet = new Packet();
        portal.on("data", async (chunk) => {

            /* 
                Pass every new chunk of data sent from the server into the pipeline,
                and also pass the packet object in, which holds the current state of the request.
                The pipeline returns the packet object, with changes made from processing the data chunk. 
            */

            packet = await packetDec.packetPipeline(chunk, packet)


            if (packet.status.pingBaked || (packet.status.handshakeBaked && !ping)) {
                let serverStatus = new ServerStatus(packet.crafted.data, packet.crafted.latency, throwOnParseError, disableJSONParse)
                clearTimeout(timeoutFunc);
                portal.destroy();
                return resolve(serverStatus);
            }

            /* 
                If the handshake and status request were sent out and replied to,
                generate the ping packet, log the time it was sent out on and send it.
            */

            if (packet.status.handshakeBaked && !packet.status.pingSent) {
                let pingRequest = await packetGen.craftPingPacket()
                packet.status.pingSentTime = Date.now();
                await portal.write(pingRequest)
                packet.status.pingSent = true;
            }
        })

        portal.once("error", (netError) => {
            clearTimeout(timeoutFunc);
            reject();
            throw netError
        })

        let timeoutFunc = setTimeout(() => {
            portal.destroy();
            throw new Error("Timed out.")
        }, timeout);

    })
}


/**
 * Used for changing the default DNS servers. 
 * @example
 * ```
    // Recommended servers
    mc.setDnsServers(["9.9.9.9", "1.1.1.1", "8.8.8.8"])
    // (Quad9, Cloudflare, Google)
    // Cloudflare is the fastest for DNS queries in most of the world.
```
 */
async function setDnsServers(serverArray: Array<string>) {
    await dns.setServers(serverArray);
    return true;
}

async function customLookup(hostname: string, options: Object, callback: CallableFunction) {
    let result = await dns.lookup(hostname, options)
    callback(null, result.address, result.family);
}

async function processSRV(hostname: string, port: number) {
    /*
     *  Tries to get a SRV record from the provided hostname, unless disabled with the disableSRV flag.
     *  The hostname can't be localhostname, the port always has to be 25565, and the hostname cannot be an IP. 
    */

    if (hostname == "localhostname" && port != 25565 && net.isIP(hostname) != 0) return { hostname, port }
    let result = await dns.resolveSrv("_minecraft._tcp." + hostname).catch(() => { })
    if (!result || result.length == 0 || !result[0].name || !result[0].port) return { hostname, port }
    return { hostname: result[0].name, port: result[0].port}
}

export default { setDnsServers, lookup }