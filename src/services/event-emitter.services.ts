import { EventEmitter } from 'events';
import { Activity } from '@/models/activity-model';
import { Types } from 'mongoose';

// Define the required shape of the payload for logging
interface ActivityPayload {
    actorId: string;
    actionType: string;
    targetModel: string;
    targetId: string;
    targetOwnerId?: string;
    contentPreview?: string;
}

// Create a singleton instance of the Event Emitter
class AppEventEmitter extends EventEmitter {}
export const eventEmitter = new AppEventEmitter();

// 🚨 Define the listener that executes the logging action
eventEmitter.on('activityLogged', async (payload: ActivityPayload) => {
    console.log("loggong activity");
    try {
        await Activity.create({
            actor: new Types.ObjectId(payload.actorId),
            actionType: payload.actionType,
            targetModel: payload.targetModel,
            targetId: new Types.ObjectId(payload.targetId),
            targetOwner: payload.targetOwnerId ? new Types.ObjectId(payload.targetOwnerId) : undefined,
            contentPreview: payload.contentPreview,
        });
    } catch (error) {
        console.error('ACTIVITY EVENT HANDLER FAILED:', error);
    }
});