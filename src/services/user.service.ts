import mongoose from 'mongoose';
import { User } from '@/models/user-model';
import { Business } from '@/models/business-model';
import { trackEvent } from '@/services/track-event.service';

export const getUserById = (userId: string) =>
  User.findById(userId).select(
    '-password -emailVerificationToken -emailVerificationExpires -twoFactorSecret -mfaRecoveryCodes',
  );

export async function updateUserProfile(
  userId: string,
  data: { firstName?: string; lastName?: string; bio?: string; profilePicture?: string; coverPicture?: string },
) {
  const updateData: Record<string, string> = {};
  if (data.firstName)     updateData.firstName      = data.firstName;
  if (data.lastName)      updateData.lastName       = data.lastName;
  if (data.bio)           updateData.bio            = data.bio;
  if (data.profilePicture) updateData.profilePicture = data.profilePicture;
  if (data.coverPicture)  updateData.coverPicture   = data.coverPicture;

  const user = await User.findByIdAndUpdate(userId, { $set: updateData }, { new: true, runValidators: true });
  if (!user) { const e: any = new Error('User not found'); e.status = 404; throw e; }

  trackEvent({
    targetId: userId, targetModel: 'User', type: 'ACTIVITY',
    activityData: { action: 'PROFILE_UPDATE', description: 'You updated your profile information' },
  }).catch(() => {});

  return user;
}

export async function updateShippingAddress(
  userId: string,
  data: { phone?: string; state?: string; city?: string; fullAddress?: string },
) {
  const updateData: Record<string, string> = {};
  if (data.phone)       updateData['shippingAddress.phone']       = data.phone.trim();
  // State is what the delivery (Fez) quote is priced on, so persist it too.
  if (data.state)       updateData['shippingAddress.state']       = data.state.trim();
  if (data.city)        updateData['shippingAddress.city']        = data.city.trim();
  if (data.fullAddress) updateData['shippingAddress.fullAddress'] = data.fullAddress.trim();

  const user = await User.findByIdAndUpdate(userId, { $set: updateData }, { new: true });
  if (!user) { const e: any = new Error('User not found'); e.status = 404; throw e; }
  return user.shippingAddress;
}

export async function convertUserToBusiness(userId: string) {
  const user = await User.findById(userId);
  if (!user || user.isBusinessOwner) {
    const e: any = new Error('Invalid request or already a business');
    e.status = 400;
    throw e;
  }
  // Note: a Payluk profile is NOT required to convert to a business — sellers
  // can set up their payment profile later. Checkout separately guards that a
  // seller has a Payluk customer before a buyer can pay.

  const useTx = process.env.USE_TRANSACTIONS === 'true';
  const session = useTx ? await mongoose.startSession() : null;

  try {
    if (session) session.startTransaction();

    await User.findByIdAndUpdate(userId, { isBusinessOwner: true }, { session: session ?? undefined });
    const businessData = {
      owner: userId,
      businessName: `${user.firstName}'s Business`,
      about: 'Update your business description here.',
      category: 'Other',
      contact: { email: user.email },
      location: { type: 'Point', coordinates: [0, 0] },
    };

    let business;
    if (session) {
      [business] = await Business.create([businessData], { session });
    } else {
      business = await Business.create(businessData);
    }

    if (session) await session.commitTransaction();

    trackEvent({
      targetId: userId, targetModel: 'User', type: 'BOTH',
      notificationData: {
        type: 'BUSINESS', title: 'Welcome Business Owner!',
        message: 'Your account has been upgraded. Start setting up your business profile.',
        sender: userId, senderModel: 'User',
        relatedId: business._id.toString(), modelType: 'Order',
      },
      activityData: { action: 'BUSINESS_CONVERSION', description: `You converted to a business: ${business.businessName}` },
    }).catch(() => {});

    return business;
  } catch (err) {
    if (session) await session.abortTransaction();
    throw err;
  } finally {
    if (session) session.endSession();
  }
}
