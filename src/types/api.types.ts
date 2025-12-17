
export type loginType = { email: string; password: string };

export type LoginResponseType = {
  success: boolean;
  message: string;
  data: {
    accessToken: string;
    refreshToken: string;
    user: {
      id: string;
      email: string;
      firstName: string;
      lastName: string;
      businessName?: string;
    };
  };
};

export type RegisterResponseType = {
  success: boolean;
  message: string;
};

export type registerType = {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  password: string;
};

// USER TYPE - matches backend IUser model
export type UserType = {
  _id: string;
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  coverPicture?: string;
  isBusinessOwner: boolean;
  profilePicture?: string;
  bio?: string; // Add this to your IUser schema if needed
  
  emailVerified?: boolean;
  twoFactorEnabled?: boolean;
  lastLoginAt?: Date;
  bookmarkedBusinesses: string[];
  bookmarkedPosts: string[];
  savedEvents: string[];
  followingUsers: string[];
  followingBusinesses: string[];
  followers: string[];
  businesses: string[];
  createdAt: Date;
  updatedAt: Date;
};

export type BusinessType = {
  _id: string;
  businessName: string;
  about: string;
  category: string;
  contact: {
    phone?: string;
    website?: string;
    email?: string;
  };
  address: {
    fullAddress: string;
  };
  operatingHours: Array<{ day: string; open: string; close: string }>;
};

export type ProfileResponse = {
  user: UserType;
  business: BusinessType | null;
  related: {
    counts: { posts: number; followers: number; following: number };
    stats: { rating: number; reviewsCount: number };
  };
};

export type RelatedData = {
  businesses: Array<{
    _id: string;
    businessName: string;
    profileImage?: string;
    coverImage?: string;
    followers?: string[];
    likes?: string[];
    category?: string;
  }>;
  recentPosts: Array<{
    _id: string;
    business: string;
    name: string;
    description: string;
    itemNumber?: string;
    price: number;
    media?: string[];
    tags?: string[];
    likes?: string[];
    createdAt: string;
    updatedAt: string;
  }>;
  counts: {
    posts: number;
    followers: number;
    following: number;
  };
};

export interface CurrentUserResponseType {
  success: boolean;
  message?: string;
  user: UserType;
  // Add this line:
  business: BusinessType | null; 
  related: RelatedData;
}


export type UsernameCheckResponse = {
  available: boolean;
  message: string; // e.g., "Username is available" or "Username is taken"
}

export interface Chat {
  id: string;
  name: string;
  message: string;
  date: string;
  avatar: string;
  isUnread: boolean;
}

// Import the interface defined above
export interface Activity {
  id: string | number;
  name: string;
  action: string;
  time: string;
  avatar: string;
}

export interface Bookmark {
  id: string;
  name: string;
  description: string;
  avatar: string;
}
