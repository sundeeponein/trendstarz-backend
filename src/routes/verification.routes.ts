import { Router } from 'express';
import { sendEmailVerification, verify } from '../controllers/verification.controller';
// Add authentication middleware as needed

const router = Router();

router.post('/send-email', sendEmailVerification);
router.post('/verify', verify);

export default router;
