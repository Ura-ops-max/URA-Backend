import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer, IncomingMessage } from 'http';
import { Types } from 'mongoose';
import { verifyToken } from '@/services/token.service';
import { isTokenBlacklisted } from '@/services/token-blacklist.service';
import { Business } from '@/models/business-model';
import { Conversation } from '@/models/conversation-model';

/**
 * Real-time (Socket.IO). Every connection must carry a valid login token, and
 * a socket may only join:
 *  - its own personal room (the user's id) or a room of a shop the user owns;
 *  - chat rooms of conversations that one of those profiles is part of.
 * Only URA's own web addresses may connect (SOCKET_ALLOWED_ORIGINS).
 */

interface SocketData {
  userId: string;
  /** The user's id plus the ids of the shops they own. */
  profileIds: Set<string>;
  /** Personal rooms this socket joined (for online/offline status). */
  joined: Set<string>;
}

/** Allowed browser origins: SOCKET_ALLOWED_ORIGINS, else FRONTEND_URL. */
export function allowedOrigins(): string[] {
  return String(process.env.SOCKET_ALLOWED_ORIGINS || process.env.FRONTEND_URL || '')
    .split(',')
    .map(o => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function isOriginAllowed(origin: string | undefined, allowed = allowedOrigins()): boolean {
  // Non-browser clients send no Origin; they still need a valid token.
  if (!origin) return true;
  return allowed.includes(origin.replace(/\/$/, ''));
}

/** Check the login token; returns who the socket is, or null. */
export async function authenticateSocketToken(
  token: unknown
): Promise<{ userId: string; profileIds: Set<string> } | null> {
  if (typeof token !== 'string' || !token) return null;
  try {
    const payload = verifyToken(token);
    if (payload.type && payload.type !== 'access') return null;
    const userId = String(payload.userId ?? '');
    if (!Types.ObjectId.isValid(userId)) return null;
    if (await isTokenBlacklisted(token)) return null;
    const shops = await Business.find({ owner: userId }).select('_id').lean();
    return { userId, profileIds: new Set([userId, ...shops.map(s => String(s._id))]) };
  } catch {
    return null;
  }
}

/** May these profiles join this conversation's chat room? */
export async function canJoinConversation(
  conversationId: unknown,
  profileIds: Set<string>
): Promise<boolean> {
  if (typeof conversationId !== 'string' || !Types.ObjectId.isValid(conversationId)) return false;
  const convo = await Conversation.findById(conversationId)
    .select('participants.participantId')
    .lean();
  return Boolean(convo?.participants?.some((p: any) => profileIds.has(String(p.participantId))));
}

const tokenFrom = (socket: Socket): unknown =>
  socket.handshake.auth?.token ||
  String(socket.handshake.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
  undefined;

class SocketService {
  private _io: SocketIOServer | null = null;

  public init(httpServer: HTTPServer) {
    const origins = allowedOrigins();
    if (!origins.length) {
      console.warn(
        '[socket] SOCKET_ALLOWED_ORIGINS and FRONTEND_URL are empty: browser connections will be refused'
      );
    }

    this._io = new SocketIOServer(httpServer, {
      cors: { origin: origins, methods: ['GET', 'POST'], credentials: true },
      // CORS headers don't stop WebSocket upgrades, so check the Origin here too.
      allowRequest: (req: IncomingMessage, callback) => {
        callback(null, isOriginAllowed(req.headers.origin, origins));
      },
    });

    // Every connection must carry a valid login token.
    this._io.use(async (socket, next) => {
      const who = await authenticateSocketToken(tokenFrom(socket));
      if (!who) return next(new Error('unauthorized'));
      const data = socket.data as SocketData;
      data.userId = who.userId;
      data.profileIds = who.profileIds;
      data.joined = new Set();
      next();
    });

    console.log('Socket Service Initialized');

    this._io.on('connection', (socket: Socket) => {
      const data = socket.data as SocketData;

      // 1. Join a personal room: only the user's own id or a shop they own.
      socket.on('setup', (profileId: unknown) => {
        const idStr = String(profileId ?? '');
        if (!data.profileIds.has(idStr)) {
          socket.emit('setup_denied', { profileId: idStr });
          return;
        }
        socket.join(idStr);
        data.joined.add(idStr);
        this._io?.emit('user_status_changed', { userId: idStr, status: 'online' });
        socket.emit('connected');
      });

      // 2. Join a chat room: only conversations the user (or their shop) is in.
      socket.on('join_chat', async (room: unknown) => {
        if (await canJoinConversation(room, data.profileIds)) {
          socket.join(String(room));
        } else {
          socket.emit('join_chat_denied', { room: String(room ?? '') });
        }
      });

      // 3. Offline status once the last connection for a profile closes.
      socket.on('disconnect', () => {
        for (const profileId of data.joined) {
          const room = this._io?.sockets.adapter.rooms.get(profileId);
          if (!room || room.size === 0) {
            this._io?.emit('user_status_changed', {
              userId: profileId,
              status: 'offline',
              lastSeen: new Date(),
            });
          }
        }
      });

      socket.on('check_online_status', (targetProfileId: string) => {
        const online = this.isOnline(targetProfileId);
        socket.emit('user_status_changed', {
          userId: targetProfileId,
          status: online ? 'online' : 'offline',
        });
      });
    });
  }

  /** Is anyone connected in this profile's room? */
  public isOnline(profileId: string | any): boolean {
    if (!this._io || !profileId) return false;
    const room = this._io.sockets.adapter.rooms.get(profileId.toString());
    return !!(room && room.size > 0);
  }

  /** Sends a live notification to a specific user/profile room. */
  public sendNotification(recipientId: string | any, notification: any) {
    if (!this._io) return;
    this._io.to(recipientId.toString()).emit('notification_received', notification);
  }

  public get io(): SocketIOServer {
    if (!this._io) {
      throw new Error('Socket.io not initialized!');
    }
    return this._io;
  }
}

export const socketService = new SocketService();
