import { Schema, model, Document, Types } from 'mongoose';

export interface IProduct extends Document {
    business: Types.ObjectId; // Always a Business
    name: string;
    category: string;
    description: string;
    price: number;
    stock: number;
    size?: string;
    media: string[]; // Master images
    likes: Types.ObjectId[];
    // Added to Interface for consistency
    averageRating: number;
    totalReviews: number;

// ── Payluk Escrow ──────────────────────────────
    paylukEscrowId:     string | null;
    paylukPaymentToken: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export const productSchema = new Schema<IProduct>(
    {
        business: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
        name: { type: String, required: true, trim: true },
        category: { type: String, default: 'General', index: true },
        description: { type: String, required: true },
        price: { type: Number, required: true },
        stock: { type: Number, required: true, default: 0 },
        size: { type: String },
        media: [{ type: String, required: true }],
        likes: [{ type: Schema.Types.ObjectId, ref: 'User' }],

        // RATING FIELDS
        averageRating: {
            type: Number,
            default: 0,
            min: 0,
            max: 5,
            index: true, // Crucial for search performance
        },
        totalReviews: {
            type: Number,
            default: 0,
        },

        // PAYLUK FIELDS
        paylukEscrowId:     { type: String, default: null },
        paylukPaymentToken: { type: String, default: null },
    },
    { timestamps: true }
);

// Optional: Add a text index for name and description to improve the 'q' search logic
productSchema.index({ name: 'text', description: 'text' });

export const Product = model<IProduct>('Product', productSchema);