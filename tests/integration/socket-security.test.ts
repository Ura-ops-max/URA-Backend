/**
 * Socket security with real connections: a valid login token is required, a
 * user can only join their own room (or their shop's), only their own chats,
 * and only from allowed web origins.
 */
import http from 'http';
import { AddressInfo } from 'net';
import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io as connect, Socket as ClientSocket } from 'socket.io-client';

const ALLOWED = 'https://www.ura.com.ng';
process.env.SOCKET_ALLOWED_ORIGINS = ALLOWED;

import { socketService } from '@/services/socket.service';
import { generateAccessToken } from '@/services/token.service';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';
import { Conversation } from '@/models/conversation-model';

let mongo: MongoMemoryServer;
let server: http.Server;
let url: string;
const clients: ClientSocket[] = [];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create(
    process.env.MONGOMS_SYSTEM_BINARY ? { binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } } : {}
  );
  await mongoose.connect(mongo.getUri());
  server = http.createServer();
  socketService.init(server);
  await new Promise<void>(r => server.listen(0, r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  while (clients.length) clients.pop()!.disconnect();
});
afterAll(async () => {
  socketService.io.close();
  await new Promise(r => server.close(r));
  await mongoose.disconnect();
  await mongo.stop();
});

let n = 0;
async function makeUser() {
  n++;
  const user = await User.create({ firstName: 'U', username: `u${n}x`, email: `u${n}x@example.com` });
  return { user, token: generateAccessToken({ userId: String(user._id), email: user.email }) };
}

function open(token?: string, origin = ALLOWED): ClientSocket {
  const c = connect(url, {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { origin },
    ...(token ? { auth: { token } } : {}),
  });
  clients.push(c);
  return c;
}

const once = <T = unknown>(c: ClientSocket, event: string, ms = 2000) =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    c.once(event, (d: T) => {
      clearTimeout(t);
      resolve(d);
    });
  });

describe('socket security', () => {
  it('refuses a connection without a valid token', async () => {
    const noToken = open();
    await expect(once<Error>(noToken, 'connect_error')).resolves.toMatchObject({ message: 'unauthorized' });
    const badToken = open('not-a-token');
    await expect(once<Error>(badToken, 'connect_error')).resolves.toMatchObject({ message: 'unauthorized' });
  });

  it('refuses a connection from another website', async () => {
    const { token } = await makeUser();
    const c = open(token, 'https://evil.example.com');
    await expect(once(c, 'connect_error')).resolves.toBeTruthy();
  });

  it("joins the user's own room and their shop's room, but not someone else's", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const shop = await Business.create({
      owner: a.user._id,
      businessName: 'A Shop',
      location: { type: 'Point', coordinates: [3.38, 6.52] },
    });
    const c = open(a.token);
    await once(c, 'connect');

    c.emit('setup', String(a.user._id));
    await once(c, 'connected');
    c.emit('setup', String(shop._id));
    await once(c, 'connected');

    c.emit('setup', String(b.user._id));
    await expect(once(c, 'setup_denied')).resolves.toEqual({ profileId: String(b.user._id) });

    // A notification for B never reaches A.
    let leaked = false;
    c.on('notification_received', () => (leaked = true));
    socketService.sendNotification(String(b.user._id), { message: 'private' });
    await new Promise(r => setTimeout(r, 200));
    expect(leaked).toBe(false);
  });

  it("can only join chats the user is part of", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const stranger = await makeUser();
    const convo = await Conversation.create({
      participants: [
        { participantId: a.user._id, participantModel: 'User' },
        { participantId: b.user._id, participantModel: 'User' },
      ],
    });

    const ok = open(a.token);
    await once(ok, 'connect');
    ok.emit('join_chat', String(convo._id));

    const spy = open(stranger.token);
    await once(spy, 'connect');
    spy.emit('join_chat', String(convo._id));
    await expect(once(spy, 'join_chat_denied')).resolves.toEqual({ room: String(convo._id) });

    let spyGot = false;
    spy.on('message:received', () => (spyGot = true));
    const okGot = once(ok, 'message:received');
    await new Promise(r => setTimeout(r, 100)); // let the join finish
    socketService.io.to(String(convo._id)).emit('message:received', { text: 'hi' });
    await expect(okGot).resolves.toEqual({ text: 'hi' });
    await new Promise(r => setTimeout(r, 100));
    expect(spyGot).toBe(false);

    spy.emit('join_chat', String(new Types.ObjectId()));
    await expect(once(spy, 'join_chat_denied')).resolves.toBeTruthy();
  });
});
