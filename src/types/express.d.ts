// src/types/express.d.ts
import { IUser } from '@/models/user-model'; // Import your User interface

declare global {
  namespace Express {
    interface Request {
      // This tells TS that every Request COULD have a user
      user: IUser; 
    }
  }
}