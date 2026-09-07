const net = require('net');

const client = new net.Socket();
client.setTimeout(5000);

client.connect(3306, '127.0.0.1', () => {
    console.log('Connected to MySQL via TCP');
});

client.on('data', (data) => {
    console.log('Received: ' + data.toString());
    client.destroy();
});

client.on('error', (err) => {
    console.log('Error: ' + err.message);
});

client.on('timeout', () => {
    console.log('TCP Socket Timeout');
    client.destroy();
});
