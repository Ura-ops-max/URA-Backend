import { Schema, model, Document, Types } from 'mongoose';
import { IProduct, productSchema } from './product-model';


export interface IPost extends Document {
  author: Types.ObjectId;
  authorType: 'User' | 'Business';
  caption: string;
  tags?: string[];
  media: string[]; // Only used for normal posts
  
  // THE LINK
  product?: Types.ObjectId | IProduct; 
  
  likes: Types.ObjectId[];
  createdAt: Date;
}

const postSchema = new Schema<IPost>({
  author: { type: Schema.Types.ObjectId, required: true, refPath: 'authorType' },
  authorType: { type: String, required: true, enum: ['User', 'Business'] },
  caption: { type: String, required: true },
  tags: [{ type: String }],
  
  // Media is optional here because if 'product' is present, 
  // we will fetch media from the Product model instead.
  media: [{ type: String }], 
  
  product: { type: Schema.Types.ObjectId, ref: 'Product' },
  
  likes: [{ type: Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

// --- CASCADING DELETE LOGIC ---
// If the product is deleted, delete all posts linked to it.
productSchema.post('findOneAndDelete', async function (doc) {
  if (doc) {
    await model('Post').deleteMany({ product: doc._id });
  }
});

export const Post = model<IPost>('Post', postSchema);