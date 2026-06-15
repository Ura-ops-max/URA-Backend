import Cart from '@/models/cart-model';
import { Product } from '@/models/product-model';

const POPULATE_OPTS = { path: 'items.product', select: 'name price media stock business' };

export const getCartForUser = (userId: string) =>
  Cart.findOne({ user: userId }).populate(POPULATE_OPTS);

export async function addItemToCart(userId: string, productId: string, quantity: number) {
  const product = await Product.findById(productId);
  if (!product) { const e: any = new Error('Product not found'); e.status = 404; throw e; }
  if (product.stock <= 0) { const e: any = new Error('Out of stock'); e.status = 400; throw e; }
  if (product.stock < quantity) { const e: any = new Error(`Only ${product.stock} left`); e.status = 400; throw e; }

  let cart = await Cart.findOne({ user: userId });
  if (!cart) cart = new Cart({ user: userId, items: [] });

  const idx = cart.items.findIndex(p => p.product.toString() === productId);
  if (idx > -1) {
    const newQty = cart.items[idx].quantity + quantity;
    if (newQty > product.stock) { const e: any = new Error('Exceeds available stock'); e.status = 400; throw e; }
    cart.items[idx].quantity = newQty;
  } else {
    cart.items.push({ product: productId, quantity, addedAt: new Date() });
  }

  await cart.save();
  return Cart.findById(cart._id).populate(POPULATE_OPTS);
}

export async function updateItemQuantity(userId: string, productId: string, quantity: number) {
  const product = await Product.findById(productId);
  if (product && product.stock < quantity) {
    const e: any = new Error('Requested quantity exceeds stock');
    e.status = 400;
    throw e;
  }
  return Cart.findOneAndUpdate(
    { user: userId, 'items.product': productId },
    { $set: { 'items.$.quantity': quantity } },
    { new: true },
  ).populate(POPULATE_OPTS);
}

export const removeItemFromCart = (userId: string, productId: string) =>
  Cart.findOneAndUpdate(
    { user: userId },
    { $pull: { items: { product: productId } } },
    { new: true },
  ).populate(POPULATE_OPTS);
