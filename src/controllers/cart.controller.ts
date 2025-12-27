import { Request, Response } from 'express';
import Cart from '@/models/cart-model';
import { Product } from '@/models/product-model';

// Helper to extract User ID from multiple possible middleware formats
const getAuthUserId = (req: Request): string | null => {
  const user = (req as any).user;
  const id = user?._id || user?.id || user?.userId;
  return id ? id.toString() : null;
};

// 1. GET CURRENT CART
export const getCart = async (req: Request, res: Response) => {
  try {
    const userId = getAuthUserId(req);
    const cart = await Cart.findOne({ user: userId }).populate({
      path: 'items.product',
      select: 'name price media stock business'
    });

    if (!cart) {
      return res.status(200).json({ user: userId, items: [], totalItems: 0, totalPrice: 0 });
    }

    res.status(200).json(cart);
  } catch (error) {
    res.status(500).json({ message: "Error fetching cart", error });
  }
};

// 2. ADD TO CART
export const addToCart = async (req: Request, res: Response) => {
  try {
    const { productId, quantity } = req.body;
    const userId = getAuthUserId(req);

    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ message: "Product not found" });
    if (product.stock <= 0) return res.status(400).json({ message: "Out of stock" });
    if (product.stock < quantity) return res.status(400).json({ message: `Only ${product.stock} left` });

    let cart = await Cart.findOne({ user: userId });
    if (!cart) cart = new Cart({ user: userId, items: [] });

    const itemIndex = cart.items.findIndex(p => p.product.toString() === productId);

    if (itemIndex > -1) {
      const newQty = cart.items[itemIndex].quantity + quantity;
      if (newQty > product.stock) return res.status(400).json({ message: "Exceeds available stock" });
      cart.items[itemIndex].quantity = newQty;
    } else {
      cart.items.push({ product: productId, quantity, addedAt: new Date() });
    }

    await cart.save();
    // Return populated so frontend gets updated totals immediately
    const updatedCart = await Cart.findById(cart._id).populate({
      path: 'items.product',
      select: 'name price media stock business'
    });
    res.status(200).json(updatedCart);
  } catch (error) {
    res.status(500).json({ message: "Error adding to cart", error });
  }
};

// 3. UPDATE QUANTITY (INC/DEC)
export const updateCartQuantity = async (req: Request, res: Response) => {
  try {
    const { productId, quantity } = req.body;
    const userId = getAuthUserId(req);

    const product = await Product.findById(productId);
    if (product && product.stock < quantity) {
      return res.status(400).json({ message: "Requested quantity exceeds stock" });
    }

    const cart = await Cart.findOneAndUpdate(
      { user: userId, "items.product": productId },
      { $set: { "items.$.quantity": quantity } },
      { new: true }
    ).populate({
      path: 'items.product',
      select: 'name price media stock business'
    });

    res.status(200).json(cart);
  } catch (error) {
    res.status(500).json({ message: "Update failed", error });
  }
};

// 4. REMOVE ITEM
export const removeFromCart = async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const userId = getAuthUserId(req);

    const cart = await Cart.findOneAndUpdate(
      { user: userId },
      { $pull: { items: { product: productId } } },
      { new: true }
    ).populate({
      path: 'items.product',
      select: 'name price media stock business'
    });
    
    res.status(200).json(cart);
  } catch (error) {
    res.status(500).json({ message: "Removal failed", error });
  }
};