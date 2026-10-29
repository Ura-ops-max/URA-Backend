import { Schema, model, Document, Types } from 'mongoose';
import { invalidateSeoForBusiness } from '@/seo/cache';

// Interface for GeoJSON
interface IPoint {
  type: 'Point';
  coordinates: [number, number]; // [longitude, latitude]
}

interface IOperatingHour {
  day: 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday';
  open: string;
  close: string;
  isClosed?: boolean;
}

export interface IBusiness extends Document {
  owner: Types.ObjectId;
  businessName: string;
  /** URL-safe, unique handle used for the public page: ura.com.ng/<slug> */
  slug: string;
  about: string;
  tagline?: string;
  category?: string; // Use string to stay flexible with your API-based categories
  businessLogo?: string;
  businessCover?: string;
  contact: {
    phone?: string;
    email?: string;
    website?: string;
    instagram?: string;
    x?: string;
    facebook?: string;
    whatsapp?: string;
  };
  address: {
    street: string;
    city: string;
    state: string;
    country: string;
    fullAddress: string;
  };
  isVerified: boolean;
  /** Neighbourhood, e.g. "Ora East". Optional, shown with city and state. */
  area?: string;
  /** Customers can visit a shop. Default false (most sell from home). */
  hasPhysicalStore?: boolean;
  /** Show the street address. Only used when hasPhysicalStore is true too. */
  showStreetAddress?: boolean;
  /** Let Google list this shop. Default true. */
  showOnGoogle?: boolean;
  /** Sent "Your shop can now be found on Google" (once). */
  googleReadyNotifiedAt?: Date;
  location?: IPoint;
  operatingHours: IOperatingHour[];
  followers: Types.ObjectId[];
  likes: Types.ObjectId[]; // Added to match schema
  averageRating: number; // Added
  totalReviews: number; // Added
  loanEligibility: number;
  descriptionVector?: number[];
}

const businessSchema = new Schema<IBusiness>(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    businessName: { type: String, required: true, trim: true },
    slug: { type: String, unique: true, sparse: true, index: true, lowercase: true, trim: true },
    about: { type: String },
    tagline: { type: String },
    category: { type: String, required: false },
    businessLogo: { type: String },
    businessCover: { type: String },
    contact: {
      phone: { type: String },
      email: { type: String },
      website: { type: String },
      instagram: { type: String },
      x: { type: String },
      facebook: { type: String },
      whatsapp: { type: String },
    },
    address: {
      street: { type: String },
      city: { type: String },
      state: { type: String },
      country: { type: String },
      fullAddress: { type: String },
    },
    area: { type: String, trim: true, maxlength: 80 },
    hasPhysicalStore: { type: Boolean, default: false },
    showStreetAddress: { type: Boolean, default: false },
    showOnGoogle: { type: Boolean, default: true },
    googleReadyNotifiedAt: { type: Date },
    location: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
      },
    },
    operatingHours: [
      {
        day: { type: String },
        open: { type: String },
        close: { type: String },
        isClosed: { type: Boolean, default: false }, // Added for "Open Now" logic
      },
    ],
    isVerified: { type: Boolean, default: false },
    followers: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    likes: [{ type: Schema.Types.ObjectId, ref: 'User' }],

    // RATING FIELDS (Now correctly placed inside schema fields)
    averageRating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
      index: true,
    },
    totalReviews: {
      type: Number,
      default: 0,
    },

    loanEligibility: { type: Number, default: 0 },
    descriptionVector: { type: [Number], select: false },
  },
  { timestamps: true }
);

// Indexes
businessSchema.index({ location: '2dsphere' });
businessSchema.index({ businessName: 'text', about: 'text', tagline: 'text' });

// Auto-assign a slug for new businesses (or whenever one is missing) so every
// business gets a public URL — ura.com.ng/<slug> — without manual setup.
// Uses `this.constructor` (same pattern as review-model.ts) rather than
// importing Business directly, since that binding isn't created until the
// model() call below.
businessSchema.pre<IBusiness>('save', async function (next) {
  if (this.slug || !this.businessName) return next();

  const BusinessModel = this.constructor as typeof Business;
  const base = slugify(this.businessName) || 'business';
  let candidate = RESERVED_SLUGS.has(base) ? `${base}-biz` : base;
  let n = 2;
  while (await BusinessModel.findOne({ slug: candidate }).select('_id').lean()) {
    candidate = `${base}-${n++}`;
  }
  this.slug = candidate;
  next();
});

// Built shop pages (Google visibility) are refreshed when the shop changes.
businessSchema.post('save', (doc: any) => invalidateSeoForBusiness(doc?._id));
businessSchema.post('findOneAndUpdate', (doc: any) => doc && invalidateSeoForBusiness(doc._id));

export const Business = model<IBusiness>('Business', businessSchema);

// ── Slug generation ─────────────────────────────────────────────
// Page paths that a business slug must never collide with (kept in sync
// with the frontend's BASE_ROUTE / reserved-word guard).
export const RESERVED_SLUGS = new Set([
  'about',
  'contact',
  'terms',
  'privacy',
  'faq',
  'invite',
  'payments',
  'products',
  'posts',
  'auth',
  'dashboard',
  'api',
  'health',
  'b',
  'login',
  'register',
  'signin',
  'signup',
  'admin',
  'settings',
  'product',
  'businesses',
  'explore',
  'search',
  'cart',
  'checkout',
  // App pages and static folders, kept in line with the frontend routes and
  // the page-builder's routing rule (docs/google-routing.md).
  'welcome',
  'google',
  'payment-complete',
  'payluk',
  'p',
  'seo',
  'sitemap',
  'sitemaps',
  'robots',
  'assets',
  'images',
  'sounds',
  'mock-data',
  'sw',
  'static',
  'favicon',
  'manifest',
  'site',
  'menu',
  'notifications',
  'wallet',
  'orders',
  'chat',
  'inventory',
]);

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
