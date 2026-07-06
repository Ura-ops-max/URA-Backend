import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { User } from '@/models/user-model';
import { asyncHandler } from '@/middleware/errorHandler';
import { generateVerificationCode } from '@/services/token.service';
import { sendVerificationEmail } from '@/services/email.service';
import { ValidationError, AuthenticationError } from '@/utils/errors';
import { HTTP_STATUS } from '@/constants';
import { trackEvent } from '@/services/track-event.service'; // Added import

/**
 * Update User Password
 */
export const updatePassword = asyncHandler(async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body;
    const userId = (req as any).user?._id;

    const user = await User.findById(userId).select('+password');
    if (!user || !user.password) {
        throw new AuthenticationError('User not found or social login user');
    }

    // Check current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
        throw new ValidationError('Current password is incorrect');
    }

    // Hash and save new password
    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();

    // 🚨 TRACK EVENT: Password Change
    await trackEvent({
        targetId: userId.toString(),
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: {
            action: 'PASSWORD_CHANGE',
            description: 'You successfully updated your account password',
            metadata: {
                ip: req.ip,
                userAgent: req.headers['user-agent']
            }
        }
    });

    res.status(HTTP_STATUS.OK).json({
        success: true,
        message: 'Password updated successfully',
    });
});

/**
 * Update Email (Triggers Re-verification)
 */
export const updateEmail = asyncHandler(async (req: Request, res: Response) => {
    const { newEmail, password } = req.body;
    const userId = (req as any).user?._id;

    const user = await User.findById(userId).select('+password');
    if (!user || !user.password) throw new AuthenticationError('User not found');

    // 1. Verify Password First
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
        throw new ValidationError('Authentication failed: Incorrect password');
    }

    // 2. Check if new email is taken
    const emailExists = await User.findOne({ email: newEmail });
    if (emailExists) throw new ValidationError('This email is already registered');

    const oldEmail = user.email;

    // 3. Generate Token & Update Database
    const { code: token, hash, expires } = generateVerificationCode();

    user.email = newEmail;
    user.emailVerified = false;
    user.emailVerificationToken = hash;
    user.emailVerificationExpires = expires;
    await user.save();

    // 🚨 TRACK EVENT: Email Update
    await trackEvent({
        targetId: userId.toString(),
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: {
            action: 'EMAIL_UPDATE',
            description: `You changed your email from ${oldEmail} to ${newEmail}`,
            metadata: {
                ip: req.ip,
                userAgent: req.headers['user-agent']
            }
        }
    });

    // 4. Return Success Response Immediately
    res.status(HTTP_STATUS.OK).json({
        success: true,
        message: 'Email updated successfully. Please check your inbox for the verification link.',
    });

    // 5. Attempt to send email in the "background"
    try {
        await sendVerificationEmail(newEmail, token);
    } catch (emailError) {
        console.error("Post-update verification email failed to send:", emailError);
    }
});

/**
 * Request Verification Email (Resend)
 */
export const resendVerification = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as any).user?._id;
    const user = await User.findById(userId);

    if (!user) throw new AuthenticationError('User not found');
    if (user.emailVerified) throw new ValidationError('Email is already verified');

    const { code: token, hash, expires } = generateVerificationCode();

    user.emailVerificationToken = hash;
    user.emailVerificationExpires = expires;
    await user.save();

    // 🚨 TRACK EVENT: Resend Verification
    await trackEvent({
        targetId: userId.toString(),
        targetModel: 'User',
        type: 'ACTIVITY',
        activityData: {
            action: 'RESEND_VERIFICATION',
            description: 'You requested a new email verification link',
        }
    });

    await sendVerificationEmail(user.email, token);

    res.status(HTTP_STATUS.OK).json({
        success: true,
        message: 'Verification email sent successfully.',
    });
});