import { Schema, model, Document, Types } from 'mongoose';

export enum PostType {
  POST = 'POST',
  PRODUCT = 'PRODUCT'
}

export interface IPost extends Document {
  // 🚨 POLYMORPHIC AUTHOR
  author: Types.ObjectId;
  authorType: 'User' | 'Business'; 
  
  type: PostType;
  caption: string;
  media: string[];
  
  // Product Fields (Required only if type is PRODUCT)
  productName?: string;
  category?: string;
  description?: string;
  price?: number;
  stock?: number;
  size?: string;
  
  likes: Types.ObjectId[];
  createdAt: Date;
}

const postSchema = new Schema<IPost>(
  {
    author: { 
      type: Schema.Types.ObjectId, 
      required: true, 
      refPath: 'authorType' // 👈 Dynamically looks up User or Business
    },
    authorType: { 
      type: String, 
      required: true, 
      enum: ['User', 'Business'] 
    },
    type: { 
      type: String, 
      enum: Object.values(PostType), 
      required: true 
    },
    caption: { type: String, required: true },
    media: [{ type: String }],

    // Product specific
    productName: { type: String },
    category: { type: String },
    description: { type: String },
    price: { type: Number },
    stock: { type: Number },
    size: { type: String },

    likes: [{ type: Schema.Types.ObjectId, ref: 'User' }],
  },
  { timestamps: true }
);

// 🛡️ VALIDATION LOGIC
// Ensure that if it's a PRODUCT, the author MUST be a Business
postSchema.pre('save', function (next) {
  if (this.type === PostType.PRODUCT && this.authorType !== 'Business') {
    return next(new Error('Products must be associated with a Business account.'));
  }
  next();
});

export const Post = model<IPost>('Post', postSchema);