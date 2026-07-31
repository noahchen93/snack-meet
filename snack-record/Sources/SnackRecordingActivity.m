#import "SnackRecordingActivity.h"

id<NSObject> SnackRecordBeginRecordingActivity(id<SnackRecordingActivityManaging> processInfo) {
    NSActivityOptions options = NSActivityUserInitiated
        | NSActivityIdleSystemSleepDisabled
        | NSActivityIdleDisplaySleepDisabled;
    return [processInfo beginActivityWithOptions:options reason:@"Recording audio with Snack Record"];
}

void SnackRecordEndRecordingActivity(id<SnackRecordingActivityManaging> processInfo, id<NSObject> activity) {
    if (!activity) return;
    [processInfo endActivity:activity];
}

BOOL SnackRecordShouldProtectActiveWork(BOOL recordingActive, BOOL finalizingMeetingAudio, BOOL transcriptionPending) {
    return recordingActive || finalizingMeetingAudio || transcriptionPending;
}
