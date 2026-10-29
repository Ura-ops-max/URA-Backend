/**
 * contentUpdatedAt: the time a shop's or product's real content last changed
 * (not likes or follows, which also move updatedAt). Used for sitemap
 * lastmod, so Google is only told about real edits.
 */
import type { Schema } from 'mongoose';

export const SHOP_CONTENT_FIELDS = [
  'businessName',
  'about',
  'tagline',
  'category',
  'area',
  'businessLogo',
  'businessCover',
  'operatingHours',
  'address',
  'contact',
  'hasPhysicalStore',
  'showStreetAddress',
  'showOnGoogle',
  'slug',
];
export const PRODUCT_CONTENT_FIELDS = [
  'name',
  'description',
  'price',
  'stock',
  'media',
  'category',
  'size',
  'unit',
  'isHidden',
];

const touches = (keys: string[], fields: string[]) =>
  keys.some(k => fields.some(f => k === f || k.startsWith(`${f}.`)));

/** Keys an update changes, from $set/$unset/... or a plain object. */
function updateKeys(update: any): string[] {
  if (!update || typeof update !== 'object') return [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(update)) {
    if (k.startsWith('$')) keys.push(...Object.keys((v as object) ?? {}));
    else keys.push(k);
  }
  return keys;
}

export function trackContentEdits(schema: Schema, fields: string[]): void {
  schema.pre('save', function (this: any) {
    if (this.isNew || fields.some(f => this.isModified(f))) this.contentUpdatedAt = new Date();
  });
  const onUpdate = function (this: any) {
    const update = this.getUpdate();
    if (touches(updateKeys(update), fields)) {
      this.set('contentUpdatedAt', new Date());
    }
  };
  schema.pre('findOneAndUpdate', onUpdate);
  schema.pre('updateOne', onUpdate);
  schema.pre('updateMany', onUpdate);
}
