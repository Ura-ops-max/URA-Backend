import { Request, Response } from 'express';
import { getAuthUserId } from '@/utils/request.utils';
import * as cartService from '@/services/cart.service';

// Cart quantities must be whole numbers of 1 or more. A negative or fractional
// quantity could be used to lower the price at checkout, so reject it here.
const parseQuantity = (raw: unknown): number | null => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
};

export const getCart = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getAuthUserId(req);
    const cart = await cartService.getCartForUser(userId!);
    if (!cart) {
      res.status(200).json({ user: userId, items: [], totalItems: 0, totalPrice: 0 });
      return;
    }
    res.status(200).json(cart);
  } catch {
    res.status(500).json({ message: 'Error fetching cart' });
  }
};

export const addToCart = async (req: Request, res: Response): Promise<void> => {
  try {
    const quantity = parseQuantity(req.body.quantity);
    if (quantity === null) {
      res.status(400).json({ message: 'Quantity must be a whole number of 1 or more.' });
      return;
    }
    const cart = await cartService.addItemToCart(getAuthUserId(req)!, req.body.productId, quantity);
    res.status(200).json(cart);
  } catch (e: any) {
    res.status(e.status || 500).json({ message: e.message });
  }
};

export const updateCartQuantity = async (req: Request, res: Response): Promise<void> => {
  try {
    const quantity = parseQuantity(req.body.quantity);
    if (quantity === null) {
      res.status(400).json({ message: 'Quantity must be a whole number of 1 or more.' });
      return;
    }
    const cart = await cartService.updateItemQuantity(
      getAuthUserId(req)!,
      req.body.productId,
      quantity
    );
    res.status(200).json(cart);
  } catch (e: any) {
    res.status(e.status || 500).json({ message: e.message });
  }
};

export const removeFromCart = async (req: Request, res: Response): Promise<void> => {
  try {
    const cart = await cartService.removeItemFromCart(
      getAuthUserId(req)!,
      String(req.params.productId)
    );
    res.status(200).json(cart);
  } catch {
    res.status(500).json({ message: 'Removal failed' });
  }
};
