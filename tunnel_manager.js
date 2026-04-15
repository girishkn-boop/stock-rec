const { spawn } = require('child_process');
const fs = require('fs');

function startTunnel() {
    console.log('Starting Serveo tunnel...');
    // We use ssh to create the tunnel. Serveo will output the URL.
    const ssh = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-R', '80:localhost:3000', 'serveo.net']);

    ssh.stdout.on('data', (data) => {
        const msg = data.toString();
        console.log(msg);
        if (msg.includes('https://')) {
            const url = msg.match(/https:\/\/[^\s]+/)[0];
            fs.writeFileSync('current_tunnel_url.txt', url);
            console.log(`NEW TUNNEL URL SAVED: ${url}`);
        }
    });

    ssh.stderr.on('data', (data) => {
        console.error(`Tunnel Stderr: ${data}`);
    });

    ssh.on('close', (code) => {
        console.log(`Tunnel connection closed (code ${code}).`);
    });
}

startTunnel();
