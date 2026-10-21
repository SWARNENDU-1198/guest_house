import { forbidden } from './errors.js';

export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(forbidden(`Requires role: ${roles.join(' or ')}`));
    }
    next();
  };

export const isStaff = (user) => ['frontdesk', 'accounts', 'admin'].includes(user?.role);
