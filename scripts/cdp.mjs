/**
 * Минимальный клиент протокола DevTools поверх WebSocket.
 *
 * Реализован вручную, чтобы проверки не тянули зависимость ради одного
 * скрипта. Вынесен в отдельный модуль, потому что используется и смоуком, и
 * витриной: две копии одного кода расходятся, и однажды уже разошлись.
 */

import net from 'node:net';

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => {
      // Незавершённые запросы обязаны упасть, а не висеть до таймаута:
      // иначе проверка «зависает» на закрытом браузере.
      for (const { reject } of this.pending.values()) {
        reject(new Error('соединение с браузером закрыто'));
      }
      this.pending.clear();
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x1) this.handleMessage(payload.toString('utf8'));
      else if (opcode === 0x8) return;
    }
  }

  handleMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  }

  sendFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    const mask = Buffer.from([1, 2, 3, 4]);
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    const masked = Buffer.alloc(length);
    for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sendFrame(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Таймаут CDP: ${method}`));
        }
      }, 30000);
    });
  }

  /** Выполнить выражение в контексте страницы. */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `Ошибка в выражении: ${result.exceptionDetails.exception?.description ?? 'неизвестно'}`,
      );
    }
    return result.result.value;
  }

  close() {
    try {
      this.socket.destroy();
    } catch {
      /* соединение уже закрыто */
    }
  }
}

/** Подключиться к цели отладки и выполнить рукопожатие WebSocket. */
export async function connectCdp(target) {
  const wsUrl = new URL(target.webSocketDebuggerUrl);
  const socket = net.connect(Number(wsUrl.port), wsUrl.hostname);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  const key = Buffer.from(`${Date.now()}${Math.random()}`).toString('base64');
  socket.write(
    `GET ${wsUrl.pathname} HTTP/1.1\r\n` +
      `Host: ${wsUrl.host}\r\n` +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      'Sec-WebSocket-Version: 13\r\n\r\n',
  );
  await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      if (chunk.toString('utf8').includes('\r\n\r\n')) {
        socket.off('data', onData);
        resolve();
      }
    };
    socket.on('data', onData);
    socket.once('error', reject);
    setTimeout(() => reject(new Error('таймаут рукопожатия WebSocket')), 10000);
  });

  return new CdpClient(socket);
}
