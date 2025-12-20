/* eslint-disable @typescript-eslint/no-explicit-any */
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { Strategy as JWTStrategy, ExtractJwt } from 'passport-jwt';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import bcrypt from 'bcryptjs';
import { User } from '@/models/user-model';
import { config } from '@/config/env.config';
import { isTokenBlacklisted } from '@/services/token-blacklist.service';

/**
 * Local Strategy (Email/Password)
 */
passport.use(
  new LocalStrategy(
    {
      // 1. We change the field name to 'identifier' to match your frontend input
      usernameField: 'identifier', 
      passwordField: 'password',
    },
    async (identifier, password, done) => {
      try {
        // 2. Search for the user where the input matches either email OR username
        const user = await User.findOne({
          $or: [
            { email: identifier.toLowerCase().trim() },
            { username: identifier.trim() }
          ],
        }).select('+password +twoFactorSecret');

        // 3. Check if user exists and has a password set
        if (!user || !user.password) {
          return done(null, false, { message: 'Invalid credentials' });
        }

        // 4. Use bcrypt to compare the plain text password with the hashed version
        const isPasswordValid = await bcrypt.compare(password, user.password);
        
        if (!isPasswordValid) {
          return done(null, false, { message: 'Invalid credentials' });
        }

        // Optional: Check account status (e.g., emailVerified or isActive)
        // if (!user.isActive) {
        //   return done(null, false, { message: 'Account is disabled' });
        // }

        return done(null, user);
      } catch (error) {
        return done(error);
      }
    }
  )
);

/**
 * JWT Strategy
 */
passport.use(
  new JWTStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.jwt.secret,
      passReqToCallback: true, // Allow access to req in verify callback
    },
    async (req, jwtPayload, done) => {
      try {
        // Extract token from request
        const token = ExtractJwt.fromAuthHeaderAsBearerToken()(req);

        if (!token) {
          return done(null, false);
        }

        // Check if token is blacklisted
        const blacklisted = await isTokenBlacklisted(token);
        if (blacklisted) {
          return done(null, false, { message: 'Token has been revoked' });
        }

        const user = await User.findById(jwtPayload.userId);
        if (!user) {
          return done(null, false);
        }

        // Attach token to user object for logout
        (user as any).token = token;
        return done(null, user);
      } catch (error) {
        return done(error, false);
      }
    }
  )
);

/**
 * Google OAuth Strategy
 */
passport.use(
  new GoogleStrategy(
    {
      clientID: config.oauth?.google?.clientId || '',
      clientSecret: config.oauth?.google?.clientSecret || '',
      callbackURL: config.oauth?.google?.callbackUrl || '/api/auth/google/callback',
    },
    async (_accessToken, _refreshToken, profile, done) => {
      try {
        // Check if user exists with this Google ID
        let user = await User.findOne({ googleId: profile.id });

        if (!user) {
          // Check if user exists with this email
          user = await User.findOne({ email: profile.emails?.[0]?.value });

          if (user) {
            // Link Google account to existing user
            user.googleId = profile.id;
            user.emailVerified = true; // Google emails are verified
            if (!user.profilePicture && profile.photos?.[0]?.value) {
              user.profilePicture = profile.photos[0].value;
            }
            await user.save();
          } else {
            // Create new user
            user = await User.create({
              googleId: profile.id,
              email: profile.emails?.[0]?.value,
              firstName: profile.name?.givenName || profile.displayName?.split(' ')[0] || 'User',
              lastName: profile.name?.familyName || profile.displayName?.split(' ')[1] || '',
              profilePicture: profile.photos?.[0]?.value,
              emailVerified: true,
            });
          }
        }

        return done(null, user);
      } catch (error) {
        return done(error as Error, undefined);
      }
    }
  )
);

/**
 * Serialize user (not used with JWT, but required by Passport)
 */
passport.serializeUser((user: any, done) => {
  done(null, user._id);
});

/**
 * Deserialize user (not used with JWT, but required by Passport)
 */
passport.deserializeUser(async (id: string, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (error) {
    done(error);
  }
});

export default passport;
