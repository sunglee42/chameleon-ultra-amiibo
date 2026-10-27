const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const classSource = source.slice(source.indexOf('        class ChameleonUltra {'), source.indexOf('            async getSlotNames()')) + '\n}';
function setup(write) {
    const context = { setTimeout: (fn, ms) => setTimeout(fn, ms === 10000 ? 50 : ms), clearTimeout, DataView, Uint8Array };
    vm.createContext(context);
    const Device = vm.runInContext(classSource + '\nChameleonUltra', context);
    const device = new Device();
    device.device = { gatt: { connected: true, disconnect() { this.connected = false; } } };
    device.rxCharacteristic = { writeValue: frame => write(device, frame) };
    return device;
}
function reply(device, cmd) {
    const frame = new DataView(new ArrayBuffer(11));
    frame.setUint16(2, cmd); frame.setUint8(9, 42);
    device.responseCallback(frame);
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
test('early notification does not release the next write', async () => {
    let busy = false, writes = 0;
    const device = setup(async (device, frame) => {
        assert.equal(busy, false, 'overlapping GATT write');
        busy = true; writes++;
        reply(device, new DataView(frame.buffer).getUint16(2));
        await delay(10);
        busy = false;
    });
    const result = await Promise.all([device.sendCommand(1), device.sendCommand(2), device.sendCommand(3)]);
    assert.equal(writes, 3);
    assert.equal(result[0].getUint8(0), 42);
    assert.equal(device.responseCallback, null);
});
test('failed write rejects caller but does not poison queue', async () => {
    let writes = 0;
    const device = setup(async (device, frame) => {
        if (++writes === 1) throw new Error('GATT operation already in progress');
        reply(device, new DataView(frame.buffer).getUint16(2));
    });
    const first = device.sendCommand(1);
    const second = device.sendCommand(2);
    await assert.rejects(first, /GATT operation/);
    assert.equal((await second).getUint8(0), 42);
    assert.equal(writes, 2);
});
test('unrelated notification does not complete a command', async () => {
    const device = setup(async device => {
        reply(device, 99);
        await delay(5);
        reply(device, 1);
    });
    assert.equal((await device.sendCommand(1)).getUint8(0), 42);
});
test('timeout disconnects and prevents queued writes; new connection has fresh queue', async () => {
    let writes = 0;
    const device = setup(async () => { writes++; });
    const first = device.sendCommand(1);
    const second = device.sendCommand(2);
    const results = await Promise.allSettled([first, second]);
    assert.match(results[0].reason.message, /逾時/);
    assert.match(results[1].reason.message, /尚未連線/);
    assert.equal(writes, 1);
    assert.equal(device.device.gatt.connected, false);
    assert.equal(device.responseCallback, null);
    const fresh = setup(async (device, frame) => reply(device, new DataView(frame.buffer).getUint16(2)));
    assert.equal((await fresh.sendCommand(1)).getUint8(0), 42);
});
test('all inline scripts parse', () => {
    for (const match of source.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});
