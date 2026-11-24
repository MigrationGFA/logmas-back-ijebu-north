

import { Router } from 'express';
import {  getWardsList } from './general.controller';

const router = Router();

// Exposed for general/public UI lookup elements. Ward names are public
// information, so this list is readable without a login: the public
// pages read the platform's wards from the database through here.
router.get('/wards', getWardsList);


export default router;