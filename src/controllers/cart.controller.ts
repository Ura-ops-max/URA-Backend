import { Request, Response } from 'express';
import { getAuthUserId } from '@/utils/request.utils';
import * as cartService from '@/services/cart.service';

export const getCart = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = getAuthUserId(req);
    const cart = await cartService.getCartForUser(userId!);
    if (!cart) { res.status(200).json({ user: userId, items: [], totalItems: 0, totalPrice: 0 }); return; }
    res.status(200).json(cart);
  } catch { res.status(500).json({ message: 'Error fetching cart' }); }
};

export const addToCart = async (req: Request, res: Response): Promise<void> => {
  try {
    const cart = await cartService.addItemToCart(getAuthUserId(req)!, req.body.productId, req.body.quantity);
    res.status(200).json(cart);
  } catch (e: any) { res.status(e.status || 500).json({ message: e.message }); }
};

export const updateCartQuantity = async (req: Request, res: Response): Promise<void> => {
  try {
    const cart = await cartService.updateItemQuantity(getAuthUserId(req)!, req.body.productId, req.body.quantity);
    res.status(200).json(cart);
  } catch (e: any) { res.status(e.status || 500).json({ message: e.message }); }
};

export const removeFromCart = async (req: Request, res: Response): Promise<void> => {
  try {
    const cart = await cartService.removeItemFromCart(getAuthUserId(req)!, req.params.productId);
    res.status(200).json(cart);
  } catch { res.status(500).json({ message: 'Removal failed' }); }
};
