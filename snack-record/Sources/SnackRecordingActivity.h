#import <Foundation/Foundation.h>

@protocol SnackRecordingActivityManaging <NSObject>
- (id<NSObject>)beginActivityWithOptions:(NSActivityOptions)options reason:(NSString *)reason;
- (void)endActivity:(id<NSObject>)activity;
@end

id<NSObject> SnackRecordBeginRecordingActivity(id<SnackRecordingActivityManaging> processInfo);
void SnackRecordEndRecordingActivity(id<SnackRecordingActivityManaging> processInfo, id<NSObject> activity);
BOOL SnackRecordShouldProtectActiveWork(BOOL recordingActive, BOOL finalizingMeetingAudio, BOOL transcriptionPending);
