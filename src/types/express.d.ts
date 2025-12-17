import { UserType } from "./api.types"; // Adjust path to where your UserType is

declare global {
  namespace Express {
    interface User extends UserType {} // Merges your UserType into Express's User
    
    interface Request {
      user?: UserType; 
    }
  }
}