import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';

class SocketService {
  private _io: SocketIOServer | null = null;

  public init(httpServer: HTTPServer) {
    this._io = new SocketIOServer(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"]
      }
    });

    console.log('Socket Service Initialized');

    this._io.on('connection', (socket: Socket) => {
      console.log('User Connected:', socket.id);

      // 1. Identify the connection & Join personal room
      socket.on('setup', (profileId: string) => {
        if (!profileId) return;

        const idStr = profileId.toString();

        // Use rooms instead of a manual Map
        socket.join(idStr);

        // Attach profileId to the socket instance for easy access on disconnect
        (socket as any).profileId = idStr;

        console.log(`Profile ${idStr} is now online.`);

        // Broadcast to all connected clients that this user is online
        this._io?.emit("user_status_changed", {
          userId: idStr,
          status: "online"
        });

        socket.emit('connected');
      });

      // 2. Join a specific chat room (Preserved existing logic)
      socket.on('join_chat', (room: string) => {
        socket.join(room);
        console.log('User joined chat room:', room);
      });

      // 3. Handle disconnection with "Self-Cleaning" Room logic
      socket.on('disconnect', () => {
        const profileId = (socket as any).profileId;

        if (profileId) {
          // Check if the user has NO remaining connections in their personal room
          const room = this._io?.sockets.adapter.rooms.get(profileId);

          if (!room || room.size === 0) {
            console.log(`Profile ${profileId} went fully offline.`);

            // Broadcast to all clients that user is offline
            this._io?.emit("user_status_changed", {
              userId: profileId,
              status: "offline",
              lastSeen: new Date()
            });
          }
        }
      });

      // Inside your init() method in the backend:
      socket.on('check_online_status', (targetProfileId: string) => {
        const online = this.isOnline(targetProfileId);
        socket.emit("user_status_changed", {
          userId: targetProfileId,
          status: online ? "online" : "offline"
        });
      });
    });
  }

  /**
   * Helper to check if a user is online by checking the Room size
   */
  public isOnline(profileId: string | any): boolean {
    if (!this._io || !profileId) return false;
    const room = this._io.sockets.adapter.rooms.get(profileId.toString());
    return !!(room && room.size > 0);
  }

  /**
   * Sends a live notification to a specific user/profile room
   */
  public sendNotification(recipientId: string | any, notification: any) {
    if (!this._io) return;
    const idStr = recipientId.toString();

    // Sends to the room named after the profileId
    this._io.to(idStr).emit('notification_received', notification);
    console.log(`Live notification sent to profile: ${idStr}`);
  }

  public get io(): SocketIOServer {
    if (!this._io) {
      throw new Error('Socket.io not initialized!');
    }
    return this._io;
  }
}

export const socketService = new SocketService();