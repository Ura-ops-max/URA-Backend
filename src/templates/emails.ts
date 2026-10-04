import { config } from '@/config/env.config';
import { logger } from '@/utils/logger';
import { transporter, sender } from '@/config/nodemailer';
import {
  passwordResetRequestTemplate,
  passwordResetSuccessTemplate,
  verificationEmailTemplate,
  workspaceInvitationTemplate,
} from './email-templates';

export const sendVerificationEmail = async (
  email: string,
  verificationToken: string
): Promise<void> => {
  // Point at the FRONTEND verify page (config.app.url is the API host, which has
  // no /verify-email page — that's why the old link 404'd). The frontend page
  // reads the token and calls the backend to complete verification.
  const verificationLink = `${config.frontend.url}/auth/verify-email?email=${email}&token=${verificationToken}`;
  try {
    const info = await transporter.sendMail({
      from: `${sender.name} <${sender.email}>`,
      to: email,
      subject: 'Verify your email',
      html: verificationEmailTemplate
        .replace('{verificationCode}', verificationToken)
        .replace('{verificationLink}', `${verificationLink}`),
    });

    logger.info('Verification email sent successfully', { messageId: info.messageId });
  } catch (error) {
    // Non-fatal: a failing mail server (e.g. bad SMTP creds / Gmail 535) must not
    // 500 registration or the resend endpoint. Log it and continue — the user is
    // still created and can re-request verification once SMTP is fixed.
    logger.error('Error sending verification email (continuing without sending)', error);
  }
};

export const sendWelcomeEmail = async (email: string, name: string): Promise<void> => {
  try {
    const info = await transporter.sendMail({
      from: `${sender.name} <${sender.email}>`,
      to: email,
      subject: 'Welcome to Team Task!',
      html: `
        <h1>Welcome ${name}!</h1>
        <p>Thank you for joining Team Task. We're excited to have you on board!</p>
        <p>If you have any questions, feel free to reach out to our support team.</p>
      `,
    });

    logger.info('Welcome email sent successfully', { messageId: info.messageId });
  } catch (error) {
    logger.error('Error sending welcome email', error);
    throw new Error(`Error sending welcome email: ${(error as Error).message}`);
  }
};

export const sendPasswordResetEmail = async (email: string, resetURL: string): Promise<void> => {
  try {
    const info = await transporter.sendMail({
      from: `${sender.name} <${sender.email}>`,
      to: email,
      subject: 'Reset your password',
      html: passwordResetRequestTemplate.replace('{resetURL}', resetURL),
    });

    logger.info('Password reset email sent successfully', { messageId: info.messageId });
  } catch (error) {
    logger.error('Error sending password reset email', error);
    throw new Error(`Error sending password reset email: ${(error as Error).message}`);
  }
};

// Function to send a password reset success email
export const sendResetSuccessEmail = async (email: string): Promise<void> => {
  try {
    const info = await transporter.sendMail({
      from: `${sender.name} <${sender.email}>`,
      to: email,
      subject: 'Password Reset Successful',
      html: passwordResetSuccessTemplate,
    });

    logger.info('Password reset success email sent successfully', { messageId: info.messageId });
  } catch (error) {
    logger.error('Error sending password reset success email', error);
    throw new Error(`Error sending password reset success email: ${(error as Error).message}`);
  }
};

export const sendWorkspaceInvitationEmail = async (
  email: string,
  inviterName: string,
  workspaceName: string,
  inviteURL: string
): Promise<void> => {
  try {
    const info = await transporter.sendMail({
      from: `${sender.name} <${sender.email}>`,
      to: email,
      subject: "You've been invited to join a Team Task workspace!",
      html: workspaceInvitationTemplate
        .replace('{inviterName}', inviterName)
        .replace('{workspaceName}', workspaceName)
        .replace('{inviteURL}', inviteURL),
    });

    logger.info('Workspace invitation email sent successfully', { messageId: info.messageId });
  } catch (error) {
    logger.error('Error sending workspace invitation email', error);
    throw new Error(`Error sending workspace invitation email: ${(error as Error).message}`);
  }
};

/**
 * Order updates (paid, shipped, ready, completed…) for buyers and sellers.
 * Never throws — an email problem must not block an order from moving forward.
 */
const escapeHtml = (t: string) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const sendOrderEmail = async (
  email: string,
  title: string,
  message: string,
  orderUrl: string,
): Promise<void> => {
  try {
    const info = await transporter.sendMail({
      from: `${sender.name} <${sender.email}>`,
      to: email,
      subject: `URA: ${title}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px;color:#111">
        <h2 style="color:#FF6B35;margin:0 0 12px">${escapeHtml(title)}</h2>
        <p style="font-size:15px;line-height:1.5">${escapeHtml(message)}</p>
        <p style="margin:24px 0"><a href="${escapeHtml(orderUrl)}" style="background:#FF6B35;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:bold">View order</a></p>
        <p style="font-size:12px;color:#888">URA — buy and sell safely with escrow.</p>
      </div>`,
    });
    logger.info('Order email sent', { messageId: info.messageId, title });
  } catch (error) {
    logger.error('Error sending order email (continuing)', error);
  }
};
