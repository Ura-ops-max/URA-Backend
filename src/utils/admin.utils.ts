import { User } from '@/models/user-model';

/**
 * URA has no admin role yet: admins are the users whose email is in
 * ADMIN_EMAILS (comma-separated).
 */
export async function isAdminUser(userId: unknown): Promise<boolean> {
  const admins = String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  if (!userId || !admins.length) return false;
  const u = await User.findById(userId).select('email').lean();
  return Boolean(u && admins.includes(String((u as any).email).toLowerCase()));
}
