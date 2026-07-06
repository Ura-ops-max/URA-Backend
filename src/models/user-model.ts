import { getRandomCoverImage } from '@/utils/fnLib';
import { Schema, model, Document, Types } from 'mongoose';

export interface IUser extends Document {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  password?: string; 
  phone: string;
  paylukCustomerId?: string;
  bio?: string;
  googleId?: string;
  microsoftId?: string;
  appleId?: string;
  profilePicture?: string;
  coverPicture?: string;
  isBusinessOwner?: boolean;
  businessName?: string; 
  emailVerified?: boolean;
  emailVerificationToken?: string;
  emailVerificationExpires?: Date;
  passwordResetToken?: string;
  passwordResetExpires?: Date;
  twoFactorEnabled?: boolean;
  twoFactorSecret?: string; // TOTP secret (encrypted at rest)
  mfaRecoveryCodes?: string[]; // hashed
  lastLoginAt?: Date;
  bookmarkedBusinesses: Types.ObjectId[]; // Ref 'Business'
  bookmarkedPosts: Types.ObjectId[]; // Changed: Ref 'Post'
  savedEvents: Types.ObjectId[]; // Saved Events
  followingUsers: Types.ObjectId[];
  followingBusinesses: Types.ObjectId[];
  followers: Types.ObjectId[];
  shippingAddress?: {
    phone?: string;
    city?: string;
    fullAddress?: string;
  };
  businesses: Types.ObjectId[];
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    firstName: { type: String, required: true },
    lastName: { type: String, required: false, default: '' },
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    phone: { type: String, trim: true, required: false },
    paylukCustomerId: { type: String, sparse: true, required: false },
    password: { type: String, select: false },
    googleId: { type: String, sparse: true, unique: true },
    microsoftId: { type: String, sparse: true, unique: true },
    appleId: { type: String, sparse: true, unique: true },
    profilePicture: { type: String },
    bio: { type: String },
    coverPicture: {
      type: String,
      default: getRandomCoverImage,
    },
    isBusinessOwner: { type: Boolean, default: false },
    businessName: { type: String, trim: true },
    emailVerified: { type: Boolean, default: false },
    emailVerificationToken: { type: String, index: true, select: false },
    emailVerificationExpires: { type: Date, select: false },
    passwordResetToken: { type: String, index: true, select: false },
    passwordResetExpires: { type: Date, select: false },
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, select: false },
    mfaRecoveryCodes: [{ type: String, select: false }],
    lastLoginAt: { type: Date },
    bookmarkedBusinesses: [{ type: Schema.Types.ObjectId, ref: 'Business' }],
    bookmarkedPosts: [{ type: Schema.Types.ObjectId, ref: 'Post' }],
    savedEvents: [{ type: Schema.Types.ObjectId, ref: 'Event' }],
    followingUsers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    followingBusinesses: [{ type: Schema.Types.ObjectId, ref: 'Business' }],
    followers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    shippingAddress: {
      phone: { type: String },
      city: { type: String },
      fullAddress: { type: String },
    },
    businesses: [{ type: Schema.Types.ObjectId, ref: 'Business' }],
  },
  { timestamps: true }
); // Automatically adds createdAt and updatedAt

userSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

userSchema.pre<IUser>('save', function (next) {
  // 1. If username exists (manual input), convert to lowercase
  if (this.username) {
    this.username = this.username.toLowerCase();
  }

  // 2. If username doesn't exist, generate it from names
  if (!this.username && this.firstName && this.lastName) {
    this.username = `_${this.firstName.toLowerCase()}${this.lastName.toLowerCase()}`;
  }

  next();
});



export const User = model<IUser>('User', userSchema);
