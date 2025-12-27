import mongoose, { Schema, Document } from 'mongoose';

export interface ICartItem {
    product: mongoose.Types.ObjectId;
    quantity: number;
    addedAt?: Date;
}

export interface ICart extends Document {
    user: mongoose.Types.ObjectId;
    items: ICartItem[];
    updatedAt: Date;
}

const CartSchema: Schema = new Schema({
    user: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true // One cart per user
    },
    items: [{
        product: {
            type: Schema.Types.ObjectId,
            ref: 'Product',
            required: true
        },
        quantity: {
            type: Number,
            required: true,
            min: [1, 'Quantity cannot be less than 1']
        },
        addedAt: {
            type: Date,
            default: Date.now
        }
    }],

}, { timestamps: true });

// Add this before the export
CartSchema.virtual('totalItems').get(function (this: ICart) {
    // Safe navigation in case items is undefined
    return this.items?.reduce((sum, item) => sum + item.quantity, 0) || 0;
});

CartSchema.virtual('totalPrice').get(function (this: ICart) {
    if (!this.items) return 0;

    return this.items.reduce((sum, item: any) => {
        // Check if product exists and has a price (populated)
        const price = item.product?.price || 0;
        return sum + (price * item.quantity);
    }, 0);
});

// Ensure virtuals are included when converting to JSON
CartSchema.set('toJSON', { virtuals: true });
CartSchema.set('toObject', { virtuals: true });

export default mongoose.model<ICart>('Cart', CartSchema);