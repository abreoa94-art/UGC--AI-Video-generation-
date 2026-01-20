import { Request, Response } from 'express';
import { Webhook } from 'svix'
import { prisma } from '../configs/prisma.js';
import * as Sentry from "@sentry/node"

const clerkWebhooks = async (req: Request, res: Response) => {
    try {
        const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SIGNING_SECRET;

        if (!WEBHOOK_SECRET) {
            throw new Error('Please add CLERK_WEBHOOK_SIGNING_SECRET to .env');
        }

        // Get the headers
        const svix_id = req.headers['svix-id'] as string;
        const svix_timestamp = req.headers['svix-timestamp'] as string;
        const svix_signature = req.headers['svix-signature'] as string;

        // If there are no headers, error out
        if (!svix_id || !svix_timestamp || !svix_signature) {
            return res.status(400).json({ error: 'Missing svix headers' });
        }

        // Get the body as string (it's a Buffer from express.raw())
        const body = req.body;
        const bodyString = Buffer.isBuffer(body) ? body.toString('utf8') : (typeof body === 'string' ? body : JSON.stringify(body));

        // Create a new Svix instance with your secret
        const wh = new Webhook(WEBHOOK_SECRET);

        let evt: any;

        // Verify the payload with the headers
        try {
            evt = wh.verify(bodyString, {
                'svix-id': svix_id,
                'svix-timestamp': svix_timestamp,
                'svix-signature': svix_signature,
            });
        } catch (err) {
            console.error('Error verifying webhook:', err);
            return res.status(400).json({ error: 'Invalid signature' });
        }

        // getting data from request
        const { data, type } = evt;

        // switch cases fro different events

        switch(type){
            case 'user.created': {
                await prisma.user.create({
                    data: {
                        id: data.id,
                        email: data?.email_addresses[0]?.email_address,
                        name: data?.first_name + ' ' + data.last_name,
                        image: data?.image_url,
                    }
                })
                break;
            }
            case 'user.updated': {
                await prisma.user.update({
                    where: {
                        id: data.id
                    },
                    data: {
                        email: data?.email_addresses[0]?.email_address,
                        name: data?.first_name + ' ' + data.last_name,
                        image: data?.image_url,
                    }
                })
                break;
            }
            case 'user.deleted': {
                await prisma.user.delete({
                    where: {
                        id: data.id
                    },
                    
                })
                break;
            }
            case 'paymentAttempt.updated': {
                if ((data.charge_type === 'recurring' || data.charge_type === "checkout" ) && data.status === 'paid') {
                    const credits = {pro: 80 , premium: 240,}

                    const clerkUserId = data?.payer?.user_id;
                    const planId: keyof typeof credits = data?.subscription_items?.[0]?.plan?.slug;

                    if (planId !== 'pro'  && planId !== 'premium' ){
                        return res.status(400).json('Invalid plan');
                    }

                    console.log(planId)

                    await prisma.user.update({
                        where: {id: clerkUserId,},
                        data: {credits: {increment: credits[planId]} }
                    })
                }
                break;
            

            }
            default:
                break;
        }

        return res.status(200).json({message: 'Webhook Recieved :' + type});

    } catch (error: any ) {
        Sentry.captureException(error);
        console.error('Webhook error:', error);
        return res.status(500).json({message: error.message})
    }
}

export default clerkWebhooks;