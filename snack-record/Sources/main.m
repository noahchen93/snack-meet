#import <Cocoa/Cocoa.h>
#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <Carbon/Carbon.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <UserNotifications/UserNotifications.h>
#import <CommonCrypto/CommonDigest.h>
#import "SnackRecordingActivity.h"
#include <math.h>

static NSString *const SnackRecordMeetingPromptKey = @"SnackRecordMeetingPrompt";
static NSString *const SnackRecordOutputDirectoryKey = @"SnackRecordOutputDirectory";
static NSString *const SnackRecordDailyFolderKey = @"SnackRecordDailyFolder";
static NSString *const SnackRecordDefaultMeetingPrompt = @"调用会议纪要 skill 帮我结构化总结下面这段会议转写，不超过 600 字。";
static NSString *const SnackRecordHandoffMetadataType = @"cn.yaowutech.snack.record-handoff+json";
static NSString *const SnackDesktopGitHubURL = @"https://github.com/yaowu-ai/snack-desktop";
static const NSUInteger SnackRecordMaximumHandoffBytes = 5 * 1024 * 1024;

static NSURL *SnackRecordApplicationSupportURL(void) {
    NSURL *applicationSupport = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
    return [applicationSupport URLByAppendingPathComponent:@"Snack Record" isDirectory:YES];
}

static NSString *PythonExecutablePath(void) {
    return [[SnackRecordApplicationSupportURL() URLByAppendingPathComponent:@"Runtime/venv/bin/python"] path];
}

static BOOL HasCompleteModelCacheAtPath(NSString *cachePath) {
    NSArray<NSString *> *models = @[
        @"iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
        @"iic--speech_fsmn_vad_zh-cn-16k-common-pytorch",
        @"iic--punc_ct-transformer_cn-en-common-vocab471067-large",
        @"iic--speech_campplus_sv_zh-cn_16k-common"
    ];
    for (NSString *model in models) {
        NSString *configuration = [cachePath stringByAppendingPathComponent:
            [NSString stringWithFormat:@"models/%@/snapshots/master/configuration.json", model]];
        if (![NSFileManager.defaultManager fileExistsAtPath:configuration]) return NO;
    }
    return YES;
}

static NSString *FFmpegExecutablePath(void) {
    for (NSString *candidate in @[@"/opt/homebrew/bin/ffmpeg", @"/usr/local/bin/ffmpeg", @"/usr/bin/ffmpeg"]) {
        if ([NSFileManager.defaultManager isExecutableFileAtPath:candidate]) return candidate;
    }
    return nil;
}

static NSColor *BrandOrange(void) {
    return [NSColor colorWithSRGBRed:1.0 green:0.45 blue:0.0 alpha:1.0];
}

static NSColor *BrandTeal(void) {
    return [NSColor colorWithName:nil dynamicProvider:^NSColor *(NSAppearance *appearance) {
        NSAppearanceName match = [appearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
        return [match isEqualToString:NSAppearanceNameDarkAqua]
            ? [NSColor colorWithSRGBRed:0.16 green:0.72 blue:0.74 alpha:1.0]
            : [NSColor colorWithSRGBRed:0.0 green:0.34 blue:0.39 alpha:1.0];
    }];
}

static NSColor *BrandHeaderBackground(void) {
    return [NSColor colorWithName:nil dynamicProvider:^NSColor *(NSAppearance *appearance) {
        NSAppearanceName match = [appearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
        return [match isEqualToString:NSAppearanceNameDarkAqua]
            ? [NSColor colorWithSRGBRed:0.03 green:0.20 blue:0.23 alpha:1.0]
            : [NSColor colorWithSRGBRed:1.0 green:0.96 blue:0.92 alpha:1.0];
    }];
}

static NSColor *BrandHeaderTextColor(void) {
    return [NSColor colorWithName:nil dynamicProvider:^NSColor *(NSAppearance *appearance) {
        NSAppearanceName match = [appearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
        return [match isEqualToString:NSAppearanceNameDarkAqua] ? NSColor.whiteColor : [NSColor colorWithWhite:0.08 alpha:1.0];
    }];
}

static NSColor *BrandHeaderMutedTextColor(void) {
    return [NSColor colorWithName:nil dynamicProvider:^NSColor *(NSAppearance *appearance) {
        NSAppearanceName match = [appearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
        return [match isEqualToString:NSAppearanceNameDarkAqua]
            ? [NSColor colorWithWhite:1.0 alpha:0.68]
            : [NSColor colorWithSRGBRed:0.25 green:0.19 blue:0.15 alpha:0.68];
    }];
}

static NSColor *AppBackground(void) {
    return [NSColor colorWithName:nil dynamicProvider:^NSColor *(NSAppearance *appearance) {
        NSAppearanceName match = [appearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
        return [match isEqualToString:NSAppearanceNameDarkAqua]
            ? [NSColor colorWithSRGBRed:0.08 green:0.08 blue:0.08 alpha:1.0]
            : [NSColor colorWithSRGBRed:0.97 green:0.97 blue:0.96 alpha:1.0];
    }];
}

static NSColor *TaskBackground(void) {
    return [NSColor colorWithName:nil dynamicProvider:^NSColor *(NSAppearance *appearance) {
        NSAppearanceName match = [appearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
        return [match isEqualToString:NSAppearanceNameDarkAqua]
            ? [NSColor colorWithSRGBRed:0.14 green:0.14 blue:0.14 alpha:1.0]
            : NSColor.whiteColor;
    }];
}

static NSColor *StatusTextColor(void) {
    return [NSColor colorWithName:nil dynamicProvider:^NSColor *(NSAppearance *appearance) {
        NSAppearanceName match = [appearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]];
        return [match isEqualToString:NSAppearanceNameDarkAqua] ? NSColor.whiteColor : NSColor.secondaryLabelColor;
    }];
}

static NSImage *RoundedApplicationIcon(void) {
    NSString *iconPath = [NSBundle.mainBundle pathForResource:@"AppIcon" ofType:@"icns"];
    NSImage *source = [[NSImage alloc] initWithContentsOfFile:iconPath];
    if (!source) return nil;
    NSSize size = NSMakeSize(1024, 1024);
    NSImage *rounded = [[NSImage alloc] initWithSize:size];
    [rounded lockFocus];
    [[NSColor clearColor] setFill];
    NSRectFillUsingOperation(NSMakeRect(0, 0, size.width, size.height), NSCompositingOperationCopy);
    NSBezierPath *clip = [NSBezierPath bezierPathWithRoundedRect:NSMakeRect(0, 0, size.width, size.height)
                                                         xRadius:220
                                                         yRadius:220];
    [clip addClip];
    [source drawInRect:NSMakeRect(0, 0, size.width, size.height)
              fromRect:NSZeroRect
             operation:NSCompositingOperationSourceOver
              fraction:1.0];
    [rounded unlockFocus];
    rounded.template = NO;
    return rounded;
}

typedef NS_ENUM(NSInteger, TranscriptionState) {
    TranscriptionStateReady,
    TranscriptionStateRecording,
    TranscriptionStateFinished,
    TranscriptionStateFailed,
};

typedef NS_ENUM(NSInteger, TranscriptionJobState) {
    TranscriptionJobStateQueued,
    TranscriptionJobStateProcessing,
    TranscriptionJobStateFinished,
    TranscriptionJobStateFailed,
};

static NSString *const TranscriptionModeFast = @"fast";
static NSString *const TranscriptionModeStandard = @"standard";

@interface FlippedView : NSView
@end

@implementation FlippedView
- (BOOL)isFlipped { return YES; }
@end

@interface TaskCardView : NSView
@end

@implementation TaskCardView
- (void)drawRect:(NSRect)dirtyRect {
    NSBezierPath *path = [NSBezierPath bezierPathWithRoundedRect:NSInsetRect(self.bounds, 0.5, 0.5) xRadius:7 yRadius:7];
    [TaskBackground() setFill];
    [path fill];
    [NSColor.separatorColor setStroke];
    path.lineWidth = 1;
    [path stroke];

    NSBezierPath *accent = [NSBezierPath bezierPathWithRoundedRect:NSMakeRect(0, 10, 4, MAX(0, NSHeight(self.bounds) - 20))
                                                           xRadius:2
                                                           yRadius:2];
    [BrandOrange() setFill];
    [accent fill];
}
@end

@interface TranscriptionJob : NSObject
@property(nonatomic, copy) NSString *identifier;
@property(nonatomic, strong) NSURL *recordingURL;
@property(nonatomic, strong) NSURL *temporaryOutputURL;
@property(nonatomic, strong) NSURL *finalOutputURL;
@property(nonatomic, strong) NSDate *startDate;
@property(nonatomic, strong) NSTask *task;
@property(nonatomic) TranscriptionJobState state;
@property(nonatomic, copy) NSString *transcriptionMode;
@property(nonatomic) double progress;
@property(nonatomic, strong) NSDate *progressStartedAt;
@property(nonatomic, strong) NSDate *estimationStartedAt;
@property(nonatomic) double estimationStartProgress;
@property(nonatomic, strong) NSView *rowView;
@property(nonatomic, strong) NSTextField *filenameField;
@property(nonatomic, strong) NSTextField *stateLabel;
@property(nonatomic, strong) NSProgressIndicator *progressIndicator;
@property(nonatomic, strong) NSButton *revealButton;
@property(nonatomic, strong) NSButton *retryButton;
@property(nonatomic, strong) NSButton *meetingNotesButton;
@property(nonatomic) BOOL cancelled;
@end

@implementation TranscriptionJob
@end

@interface TranscriptionController : NSObject <NSTextFieldDelegate, SCStreamOutput, SCStreamDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, copy) NSString *interfaceLanguage;
@property(nonatomic, strong) NSTextField *subtitleLabel;
@property(nonatomic, strong) NSTextField *tasksTitleLabel;
@property(nonatomic, strong) NSTextField *statusLabel;
@property(nonatomic, strong) NSButton *recordButton;
@property(nonatomic, strong) NSButton *settingsButton;
@property(nonatomic, strong) NSButton *importButton;
@property(nonatomic, strong) NSButton *clearJobsButton;
@property(nonatomic, strong) NSScrollView *jobsScrollView;
@property(nonatomic, strong) FlippedView *jobsDocumentView;
@property(nonatomic, strong) NSPanel *recordingPanel;
@property(nonatomic, strong) NSPanel *toastPanel;
@property(nonatomic, strong) NSTextField *recordingTimerLabel;
@property(nonatomic, strong) NSTextField *recordingTitleLabel;
@property(nonatomic, strong) NSTimer *recordingTimer;
@property(nonatomic, strong) AVAudioEngine *audioEngine;
@property(nonatomic, strong) AVAudioFile *audioFile;
@property(nonatomic, strong) SCStream *screenStream;
@property(nonatomic, strong) AVAssetWriter *systemAudioWriter;
@property(nonatomic, strong) AVAssetWriterInput *systemAudioWriterInput;
@property(nonatomic) dispatch_queue_t screenAudioQueue;
@property(nonatomic, strong) NSURL *systemAudioURL;
@property(nonatomic) BOOL systemAudioWriterStarted;
@property(nonatomic) BOOL recordingMeetingAudio;
@property(nonatomic) BOOL finalizingMeetingAudio;
@property(nonatomic) BOOL mixingMeetingAudio;
@property(nonatomic) BOOL startingRecording;
@property(nonatomic) BOOL stoppingRecording;
@property(nonatomic) BOOL shuttingDown;
@property(nonatomic) BOOL microphoneTapInstalled;
@property(nonatomic) NSUInteger recordingSessionGeneration;
@property(nonatomic, strong) NSURL *recordingURL;
@property(nonatomic, strong) NSDate *recordingStartDate;
@property(nonatomic, strong) id<NSObject> recordingActivity;
@property(nonatomic, strong) NSMutableArray<TranscriptionJob *> *jobs;
@property(nonatomic, strong) NSURL *storageDirectory;
@property(nonatomic, strong) NSURL *recordingsDirectory;
@property(nonatomic, strong) NSURL *jobsMetadataURL;
@property(nonatomic) dispatch_queue_t transcriptionQueue;
@property(nonatomic, strong) NSTask *modelWorkerTask;
@property(nonatomic, strong) NSFileHandle *modelWorkerInput;
@property(nonatomic, strong) NSFileHandle *modelWorkerOutput;
@property(nonatomic, strong) NSMutableData *modelWorkerReadBuffer;
@property(nonatomic) TranscriptionState currentState;
@property(nonatomic, copy) NSString *transcriptionMode;
@property(nonatomic, copy) NSString *pendingSuggestedFilename;
@property(nonatomic) BOOL waitingForMicrophonePermission;
@property(nonatomic, copy) void (^stateDidChange)(TranscriptionState state);
@property(nonatomic, copy) void (^showSettingsHandler)(void);
@property(nonatomic, copy) void (^meetilyExportHandler)(NSURL *, NSString *);
- (void)toggleRecording;
- (void)startRecordingIfNeeded;
- (void)stopRecordingIfNeeded;
- (void)beginAudioCaptureForGeneration:(NSUInteger)generation;
- (void)cancelPendingRecordingStart;
- (void)refreshMicrophoneAuthorization;
- (BOOL)hasActiveWork;
- (BOOL)hasPendingTranscriptions;
- (void)cancelTranscriptions;
- (void)shutdownForApplicationTerminationWithCompletion:(dispatch_block_t)completion;
- (void)applyInterfaceLanguage:(NSString *)language;
- (void)applyTranscriptionMode:(NSString *)mode;
- (void)preloadModels;
- (void)refreshIntegrationAvailability;
- (void)transcribeJob:(TranscriptionJob *)job;
- (BOOL)runWorkerRequest:(NSData *)requestData forJob:(TranscriptionJob *)job;
- (void)shutdownWorker;
@end

@implementation TranscriptionController

- (instancetype)init {
    self = [super init];
    if (self) {
        _audioEngine = [[AVAudioEngine alloc] init];
        _interfaceLanguage = @"en";
        _transcriptionMode = TranscriptionModeFast;
        _jobs = [NSMutableArray array];
        _transcriptionQueue = dispatch_queue_create("local.snack-record.transcription", DISPATCH_QUEUE_SERIAL);
        _screenAudioQueue = dispatch_queue_create("local.snack-record.system-audio", DISPATCH_QUEUE_SERIAL);
        [self configurePersistentStorage];
        [self loadPersistedJobs];
        [self configureWindow];
        [self configureRecordingPanel];
        [self renderState:TranscriptionStateReady message:nil];
        [self preloadModels];
        for (TranscriptionJob *job in self.jobs) {
            if (job.state == TranscriptionJobStateQueued) [self transcribeJob:job];
        }
    }
    return self;
}

- (void)showWindow {
    [self refreshIntegrationAvailability];
    [self.window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)configurePersistentStorage {
    NSURL *applicationSupport = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
    self.storageDirectory = [applicationSupport URLByAppendingPathComponent:@"Snack Record" isDirectory:YES];
    self.recordingsDirectory = [self.storageDirectory URLByAppendingPathComponent:@"Recordings" isDirectory:YES];
    self.jobsMetadataURL = [self.storageDirectory URLByAppendingPathComponent:@"recent-jobs.plist"];
    [NSFileManager.defaultManager createDirectoryAtURL:self.recordingsDirectory withIntermediateDirectories:YES attributes:nil error:nil];
}

- (void)loadPersistedJobs {
    NSArray<NSDictionary *> *storedJobs = [NSArray arrayWithContentsOfURL:self.jobsMetadataURL];
    for (NSDictionary *stored in [storedJobs subarrayWithRange:NSMakeRange(0, MIN((NSUInteger)7, storedJobs.count))]) {
        NSString *audioPath = stored[@"audioPath"];
        if (![audioPath isKindOfClass:NSString.class]) continue;
        TranscriptionJob *job = [[TranscriptionJob alloc] init];
        job.identifier = [stored[@"identifier"] isKindOfClass:NSString.class] ? stored[@"identifier"] : NSUUID.UUID.UUIDString;
        job.recordingURL = [NSURL fileURLWithPath:audioPath];
        NSString *outputPath = stored[@"outputPath"];
        if ([outputPath isKindOfClass:NSString.class] && outputPath.length > 0) job.finalOutputURL = [NSURL fileURLWithPath:outputPath];
        job.startDate = [stored[@"startDate"] isKindOfClass:NSDate.class] ? stored[@"startDate"] : NSDate.date;
        NSString *storedMode = stored[@"transcriptionMode"];
        job.transcriptionMode = [storedMode isEqualToString:TranscriptionModeStandard]
            ? TranscriptionModeStandard
            : TranscriptionModeFast;
        NSInteger storedState = [stored[@"state"] integerValue];
        BOOL canResume = [NSFileManager.defaultManager fileExistsAtPath:job.recordingURL.path];
        if (storedState == TranscriptionJobStateFinished) {
            job.state = TranscriptionJobStateFinished;
        } else if ((storedState == TranscriptionJobStateQueued || storedState == TranscriptionJobStateProcessing) && canResume) {
            job.state = TranscriptionJobStateQueued;
            job.temporaryOutputURL = [[job.recordingURL URLByDeletingLastPathComponent]
                URLByAppendingPathComponent:[NSString stringWithFormat:@"result-%@.txt", NSUUID.UUID.UUIDString]];
        } else {
            job.state = TranscriptionJobStateFailed;
        }
        job.filenameField = [[NSTextField alloc] init];
        NSString *filename = stored[@"filename"];
        job.filenameField.stringValue = [filename isKindOfClass:NSString.class] ? filename : [self defaultFilenameForDate:job.startDate];
        job.filenameField.delegate = self;
        [self.jobs addObject:job];
    }
}

- (void)persistJobs {
    NSMutableArray<NSDictionary *> *storedJobs = [NSMutableArray array];
    for (TranscriptionJob *job in self.jobs) {
        [storedJobs addObject:@{
            @"identifier": job.identifier ?: NSUUID.UUID.UUIDString,
            @"audioPath": job.recordingURL.path ?: @"",
            @"outputPath": job.finalOutputURL.path ?: @"",
            @"filename": job.filenameField.stringValue ?: @"",
            @"startDate": job.startDate ?: NSDate.date,
            @"state": @(job.state),
            @"transcriptionMode": job.transcriptionMode ?: TranscriptionModeFast,
        }];
    }
    [storedJobs writeToURL:self.jobsMetadataURL atomically:YES];
}

- (void)trimJobHistoryIfNeeded {
    while (self.jobs.count > 7) {
        TranscriptionJob *oldest = self.jobs.lastObject;
        if ([oldest.recordingURL.path hasPrefix:self.recordingsDirectory.path]) {
            [NSFileManager.defaultManager removeItemAtURL:oldest.recordingURL error:nil];
        }
        [self.jobs removeLastObject];
    }
}

- (BOOL)isChineseInterface {
    return [self.interfaceLanguage isEqualToString:@"zh"];
}

- (NSString *)english:(NSString *)english chinese:(NSString *)chinese {
    return [self isChineseInterface] ? chinese : english;
}

- (void)applyInterfaceLanguage:(NSString *)language {
    self.interfaceLanguage = [language isEqualToString:@"zh"] ? @"zh" : @"en";
    self.subtitleLabel.stringValue = [self english:@"RECORD  ·  Local meeting transcription" chinese:@"RECORD  ·  本地会议录音与转写"];
    self.tasksTitleLabel.stringValue = [self english:@"Transcription tasks" chinese:@"转写任务"];
    self.importButton.title = [self english:@"Upload local audio" chinese:@"上传本地音频文件"];
    [self styleImportButtonTitle];
    self.importButton.toolTip = [self english:@"Choose local audio files to transcribe" chinese:@"选择本地音频文件进行转写"];
    self.clearJobsButton.toolTip = [self english:@"Clear transcription tasks" chinese:@"清空转写任务"];
    self.settingsButton.toolTip = [self english:@"Settings" chinese:@"设置"];
    [self rebuildJobsView];
    [self renderState:self.currentState message:nil];
}

- (void)applyTranscriptionMode:(NSString *)mode {
    self.transcriptionMode = [mode isEqualToString:TranscriptionModeStandard]
        ? TranscriptionModeStandard
        : TranscriptionModeFast;
}

- (void)configureWindow {
    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 500, 520)
                                               styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
                                                 backing:NSBackingStoreBuffered
                                                   defer:NO];
    self.window.title = @"Snack Record";
    self.window.releasedWhenClosed = NO;
    self.window.contentMinSize = NSMakeSize(500, 520);
    self.window.backgroundColor = AppBackground();
    self.window.collectionBehavior = NSWindowCollectionBehaviorFullScreenPrimary;
    [self.window center];

    NSView *view = self.window.contentView;

    NSBox *brandHeader = [[NSBox alloc] initWithFrame:NSMakeRect(0, 400, 500, 120)];
    brandHeader.boxType = NSBoxCustom;
    brandHeader.borderWidth = 0;
    brandHeader.fillColor = BrandHeaderBackground();
    brandHeader.autoresizingMask = NSViewWidthSizable | NSViewMinYMargin;
    [view addSubview:brandHeader];

    NSBox *brandAccent = [[NSBox alloc] initWithFrame:NSMakeRect(0, 516, 500, 4)];
    brandAccent.boxType = NSBoxCustom;
    brandAccent.borderWidth = 0;
    brandAccent.fillColor = BrandOrange();
    brandAccent.autoresizingMask = NSViewWidthSizable | NSViewMinYMargin;
    [view addSubview:brandAccent];

    NSImageView *brandIcon = [[NSImageView alloc] initWithFrame:NSMakeRect(20, 423, 72, 72)];
    brandIcon.image = RoundedApplicationIcon();
    brandIcon.imageScaling = NSImageScaleProportionallyUpOrDown;
    brandIcon.autoresizingMask = NSViewMinYMargin;
    [view addSubview:brandIcon];

    NSTextField *brandTitle = [NSTextField labelWithString:@"Snack Record"];
    brandTitle.font = [NSFont systemFontOfSize:22 weight:NSFontWeightSemibold];
    brandTitle.textColor = BrandHeaderTextColor();
    brandTitle.frame = NSMakeRect(106, 459, 230, 30);
    brandTitle.autoresizingMask = NSViewMinYMargin;
    [view addSubview:brandTitle];

    self.subtitleLabel = [NSTextField labelWithString:@"RECORD  ·  Local meeting transcription"];
    self.subtitleLabel.font = [NSFont systemFontOfSize:11 weight:NSFontWeightMedium];
    self.subtitleLabel.textColor = BrandHeaderMutedTextColor();
    self.subtitleLabel.frame = NSMakeRect(107, 432, 230, 20);
    self.subtitleLabel.autoresizingMask = NSViewMinYMargin;
    [view addSubview:self.subtitleLabel];

    self.statusLabel = [NSTextField labelWithString:@""];
    self.statusLabel.font = [NSFont systemFontOfSize:12];
    self.statusLabel.textColor = StatusTextColor();
    self.statusLabel.alignment = NSTextAlignmentCenter;
    self.statusLabel.lineBreakMode = NSLineBreakByTruncatingTail;
    self.statusLabel.frame = NSMakeRect(94, 365, 312, 22);
    self.statusLabel.autoresizingMask = NSViewWidthSizable | NSViewMinYMargin;
    [view addSubview:self.statusLabel];

    self.recordButton = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:@"mic.fill" accessibilityDescription:@"Start recording"] target:self action:@selector(toggleRecording:)];
    self.recordButton.bordered = NO;
    self.recordButton.imagePosition = NSImageOnly;
    self.recordButton.image = [self.recordButton.image imageWithSymbolConfiguration:[NSImageSymbolConfiguration configurationWithPointSize:21 weight:NSFontWeightSemibold]];
    self.recordButton.toolTip = @"Start meeting recording (Control+R)";
    self.recordButton.contentTintColor = NSColor.whiteColor;
    self.recordButton.frame = NSMakeRect(426, 434, 52, 52);
    self.recordButton.wantsLayer = YES;
    self.recordButton.layer.backgroundColor = BrandOrange().CGColor;
    self.recordButton.layer.cornerRadius = 26;
    self.recordButton.layer.masksToBounds = YES;
    self.recordButton.autoresizingMask = NSViewMinXMargin | NSViewMinYMargin;
    [view addSubview:self.recordButton];

    self.settingsButton = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:@"gearshape" accessibilityDescription:@"Settings"] target:self action:@selector(showSettings:)];
    self.settingsButton.bordered = NO;
    self.settingsButton.imagePosition = NSImageOnly;
    self.settingsButton.image = [self.settingsButton.image imageWithSymbolConfiguration:[NSImageSymbolConfiguration configurationWithPointSize:19 weight:NSFontWeightMedium]];
    self.settingsButton.contentTintColor = BrandOrange();
    self.settingsButton.toolTip = @"Settings";
    self.settingsButton.frame = NSMakeRect(364, 434, 52, 52);
    self.settingsButton.wantsLayer = YES;
    self.settingsButton.layer.backgroundColor = NSColor.whiteColor.CGColor;
    self.settingsButton.layer.cornerRadius = 26;
    self.settingsButton.layer.borderColor = [BrandOrange() colorWithAlphaComponent:0.18].CGColor;
    self.settingsButton.layer.borderWidth = 1;
    self.settingsButton.layer.masksToBounds = YES;
    self.settingsButton.autoresizingMask = NSViewMinXMargin | NSViewMinYMargin;
    [view addSubview:self.settingsButton];

    NSBox *divider = [[NSBox alloc] initWithFrame:NSMakeRect(20, 352, 460, 1)];
    divider.boxType = NSBoxSeparator;
    divider.autoresizingMask = NSViewWidthSizable | NSViewMinYMargin;
    [view addSubview:divider];

    self.tasksTitleLabel = [NSTextField labelWithString:@"Transcription tasks"];
    self.tasksTitleLabel.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
    self.tasksTitleLabel.frame = NSMakeRect(46, 320, 174, 20);
    self.tasksTitleLabel.autoresizingMask = NSViewMinYMargin;
    [view addSubview:self.tasksTitleLabel];

    NSImageView *tasksIcon = [[NSImageView alloc] initWithFrame:NSMakeRect(20, 319, 18, 18)];
    tasksIcon.image = [NSImage imageWithSystemSymbolName:@"mic.fill" accessibilityDescription:@"转写任务"];
    tasksIcon.image = [tasksIcon.image imageWithSymbolConfiguration:[NSImageSymbolConfiguration configurationWithPointSize:14 weight:NSFontWeightSemibold]];
    tasksIcon.contentTintColor = BrandOrange();
    tasksIcon.autoresizingMask = NSViewMinYMargin;
    [view addSubview:tasksIcon];

    self.importButton = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:@"square.and.arrow.up" accessibilityDescription:@"上传本地音频文件"] target:self action:@selector(importAudioFiles:)];
    self.importButton.title = @"Upload local audio";
    self.importButton.imagePosition = NSImageLeading;
    self.importButton.bezelStyle = NSBezelStyleRounded;
    self.importButton.bezelColor = BrandOrange();
    self.importButton.contentTintColor = NSColor.whiteColor;
    self.importButton.toolTip = @"Choose local audio files to transcribe";
    self.importButton.frame = NSMakeRect(274, 313, 162, 30);
    self.importButton.autoresizingMask = NSViewMinXMargin | NSViewMinYMargin;
    [self styleImportButtonTitle];
    [view addSubview:self.importButton];

    self.clearJobsButton = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:@"trash" accessibilityDescription:@"清空转写任务"] target:self action:@selector(clearAllJobs:)];
    self.clearJobsButton.bezelStyle = NSBezelStyleTexturedRounded;
    self.clearJobsButton.imagePosition = NSImageOnly;
    self.clearJobsButton.contentTintColor = NSColor.systemRedColor;
    self.clearJobsButton.toolTip = @"清空转写任务";
    self.clearJobsButton.frame = NSMakeRect(446, 313, 34, 30);
    self.clearJobsButton.autoresizingMask = NSViewMinXMargin | NSViewMinYMargin;
    [view addSubview:self.clearJobsButton];

    self.jobsDocumentView = [[FlippedView alloc] initWithFrame:NSMakeRect(0, 0, 452, 280)];
    self.jobsDocumentView.autoresizingMask = NSViewWidthSizable;
    self.jobsScrollView = [[NSScrollView alloc] initWithFrame:NSMakeRect(20, 22, 460, 286)];
    self.jobsScrollView.documentView = self.jobsDocumentView;
    self.jobsScrollView.hasVerticalScroller = YES;
    self.jobsScrollView.autohidesScrollers = YES;
    self.jobsScrollView.drawsBackground = NO;
    self.jobsScrollView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [view addSubview:self.jobsScrollView];

    [self rebuildJobsView];
}

- (void)styleImportButtonTitle {
    self.importButton.attributedTitle = [[NSAttributedString alloc] initWithString:self.importButton.title
                                                                        attributes:@{
        NSForegroundColorAttributeName: NSColor.whiteColor,
        NSFontAttributeName: [NSFont systemFontOfSize:12 weight:NSFontWeightMedium],
    }];
}

- (void)showSettings:(id)sender {
    if (self.showSettingsHandler) self.showSettingsHandler();
}

- (void)importAudioFiles:(id)sender {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.title = [self english:@"Choose audio to transcribe" chinese:@"选择要转写的音频"];
    panel.prompt = [self english:@"Upload" chinese:@"上传"];
    panel.canChooseFiles = YES;
    panel.canChooseDirectories = NO;
    panel.allowsMultipleSelection = YES;
    NSMutableArray<UTType *> *contentTypes = [NSMutableArray array];
    for (NSString *extension in @[@"wav", @"m4a", @"mp3", @"aac", @"flac", @"ogg", @"caf", @"aiff", @"mp4", @"mov"]) {
        UTType *type = [UTType typeWithFilenameExtension:extension];
        if (type) [contentTypes addObject:type];
    }
    panel.allowedContentTypes = contentTypes;
    __weak typeof(self) weakSelf = self;
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        if (result != NSModalResponseOK) return;
        for (NSURL *url in panel.URLs) {
            NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:url.path error:nil];
            NSDate *startDate = attributes[NSFileCreationDate] ?: NSDate.date;
            NSString *baseName = url.lastPathComponent.stringByDeletingPathExtension;
            NSString *fallbackName = [weakSelf english:@"Local audio" chinese:@"本地音频"];
            NSString *suffix = [weakSelf english:@"-transcript.txt" chinese:@"-转写.txt"];
            NSString *filename = [NSString stringWithFormat:@"%@%@", baseName.length > 0 ? baseName : fallbackName, suffix];
            [weakSelf enqueueRecordingURL:url startDate:startDate suggestedFilename:filename];
        }
        [weakSelf renderState:TranscriptionStateReady message:[weakSelf english:@"Local files added to the transcription queue" chinese:@"本地文件已加入转写任务"]];
    }];
}

- (void)clearAllJobs:(id)sender {
    if (self.jobs.count == 0) return;
    NSAlert *alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleWarning;
    alert.messageText = [self english:@"Clear all transcription tasks?" chinese:@"清空全部转写任务？"];
    alert.informativeText = [self english:@"Queued and running tasks will be cancelled, and cached audio will be deleted. TXT files already saved to Desktop will not be deleted." chinese:@"等待中和正在处理的任务将被取消，内部音频缓存会被删除；已经保存到桌面的 TXT 文件不会被删除。"];
    [alert addButtonWithTitle:[self english:@"Cancel" chinese:@"取消"]];
    [alert addButtonWithTitle:[self english:@"Clear" chinese:@"清空"]];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
        if (response != NSAlertSecondButtonReturn) return;
        for (TranscriptionJob *job in self.jobs) {
            job.cancelled = YES;
            if (job.task.isRunning) [job.task terminate];
            if ([job.recordingURL.path hasPrefix:self.recordingsDirectory.path]) {
                [NSFileManager.defaultManager removeItemAtURL:job.recordingURL error:nil];
            }
            if ([job.temporaryOutputURL.path hasPrefix:self.storageDirectory.path]) {
                [NSFileManager.defaultManager removeItemAtURL:job.temporaryOutputURL error:nil];
            }
        }
        [self.jobs removeAllObjects];
        [self persistJobs];
        [self rebuildJobsView];
        if (!self.audioEngine.isRunning) [self renderState:TranscriptionStateReady message:nil];
    }];
}

- (void)configureRecordingPanel {
    self.recordingPanel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 248, 78)
                                                     styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                                       backing:NSBackingStoreBuffered
                                                         defer:NO];
    self.recordingPanel.opaque = NO;
    self.recordingPanel.backgroundColor = NSColor.clearColor;
    self.recordingPanel.hasShadow = YES;
    self.recordingPanel.level = NSStatusWindowLevel;
    self.recordingPanel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;

    NSVisualEffectView *card = [[NSVisualEffectView alloc] initWithFrame:NSMakeRect(0, 0, 248, 78)];
    card.material = NSVisualEffectMaterialHUDWindow;
    card.blendingMode = NSVisualEffectBlendingModeWithinWindow;
    card.state = NSVisualEffectStateActive;
    card.wantsLayer = YES;
    card.layer.cornerRadius = 10;
    card.layer.masksToBounds = YES;
    self.recordingPanel.contentView = card;

    NSBox *recordingAccent = [[NSBox alloc] initWithFrame:NSMakeRect(0, 75, 248, 3)];
    recordingAccent.boxType = NSBoxCustom;
    recordingAccent.borderWidth = 0;
    recordingAccent.fillColor = BrandOrange();
    [card addSubview:recordingAccent];

    NSImageView *recordingIcon = [[NSImageView alloc] initWithFrame:NSMakeRect(18, 27, 24, 24)];
    recordingIcon.image = [NSImage imageWithSystemSymbolName:@"record.circle.fill" accessibilityDescription:@"正在录音"];
    recordingIcon.contentTintColor = NSColor.systemRedColor;
    [card addSubview:recordingIcon];

    self.recordingTitleLabel = [NSTextField labelWithString:@"Recording meeting"];
    self.recordingTitleLabel.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
    self.recordingTitleLabel.frame = NSMakeRect(52, 40, 136, 20);
    [card addSubview:self.recordingTitleLabel];

    self.recordingTimerLabel = [NSTextField labelWithString:@"00:00"];
    self.recordingTimerLabel.font = [NSFont monospacedDigitSystemFontOfSize:12 weight:NSFontWeightRegular];
    self.recordingTimerLabel.textColor = NSColor.secondaryLabelColor;
    self.recordingTimerLabel.frame = NSMakeRect(52, 17, 100, 20);
    [card addSubview:self.recordingTimerLabel];

    NSButton *stopButton = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:@"stop.fill" accessibilityDescription:@"停止录音"] target:self action:@selector(stopRecordingFromCard:)];
    stopButton.bezelStyle = NSBezelStyleCircular;
    stopButton.imagePosition = NSImageOnly;
    stopButton.contentTintColor = NSColor.systemRedColor;
    stopButton.toolTip = @"Stop and transcribe";
    stopButton.frame = NSMakeRect(196, 21, 36, 36);
    [card addSubview:stopButton];
}

- (void)showRecordingCard {
    NSScreen *screen = NSScreen.mainScreen ?: NSScreen.screens.firstObject;
    NSRect visibleFrame = screen.visibleFrame;
    NSSize size = self.recordingPanel.frame.size;
    [self.recordingPanel setFrameOrigin:NSMakePoint(NSMaxX(visibleFrame) - size.width - 20,
                                                     NSMaxY(visibleFrame) - size.height - 20)];
    [self.recordingPanel orderFrontRegardless];
    [self.recordingTimer invalidate];
    self.recordingTimer = [NSTimer scheduledTimerWithTimeInterval:1.0 target:self selector:@selector(updateRecordingTimer:) userInfo:nil repeats:YES];
    [self updateRecordingTimer:nil];
}

- (void)hideRecordingCard {
    [self.recordingTimer invalidate];
    self.recordingTimer = nil;
    [self.recordingPanel orderOut:nil];
}

- (void)updateRecordingTimer:(NSTimer *)timer {
    NSTimeInterval elapsed = self.recordingStartDate ? [NSDate.date timeIntervalSinceDate:self.recordingStartDate] : 0;
    NSInteger totalSeconds = MAX(0, (NSInteger)elapsed);
    self.recordingTimerLabel.stringValue = [NSString stringWithFormat:@"%02ld:%02ld", (long)(totalSeconds / 60), (long)(totalSeconds % 60)];
}

- (void)stopRecordingFromCard:(id)sender { [self stopRecordingIfNeeded]; }
- (void)toggleRecording:(id)sender { [self toggleRecording]; }

- (void)toggleRecording {
    if (self.shuttingDown || self.stoppingRecording || self.finalizingMeetingAudio) return;
    if (self.startingRecording && !self.audioEngine.isRunning) {
        [self cancelPendingRecordingStart];
        return;
    }
    if (self.audioEngine.isRunning) {
        [self stopRecording];
    } else {
        [self startRecording];
    }
}

- (void)startRecordingIfNeeded {
    if (!self.shuttingDown && !self.audioEngine.isRunning && !self.startingRecording &&
        !self.stoppingRecording && !self.finalizingMeetingAudio) {
        [self startRecording];
    }
}

- (void)stopRecordingIfNeeded {
    if (self.startingRecording && !self.audioEngine.isRunning) {
        [self cancelPendingRecordingStart];
        return;
    }
    if (self.audioEngine.isRunning && !self.stoppingRecording && !self.finalizingMeetingAudio) {
        [self stopRecording];
    }
}

- (void)startRecording {
    if (self.shuttingDown || self.startingRecording || self.stoppingRecording ||
        self.finalizingMeetingAudio || self.audioEngine.isRunning) return;
    self.startingRecording = YES;
    self.recordingSessionGeneration += 1;
    self.recordButton.enabled = NO;
    __weak typeof(self) weakSelf = self;
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio completionHandler:^(BOOL granted) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (weakSelf.shuttingDown || !weakSelf.startingRecording) return;
            if (!granted) {
                weakSelf.startingRecording = NO;
                weakSelf.recordButton.enabled = YES;
                weakSelf.waitingForMicrophonePermission = YES;
                [weakSelf renderState:TranscriptionStateFailed message:[weakSelf english:@"Allow microphone access in System Settings" chinese:@"请在系统设置中允许麦克风访问"]];
                return;
            }
            weakSelf.waitingForMicrophonePermission = NO;
            weakSelf.recordingMeetingAudio = YES;
            [weakSelf beginSystemAudioCapture];
        });
    }];
}

- (void)beginSystemAudioCapture {
    if (self.shuttingDown || !self.startingRecording) return;
    NSUInteger generation = self.recordingSessionGeneration;
    self.recordButton.enabled = NO;
    self.statusLabel.stringValue = [self english:@"Requesting system audio access…" chinese:@"正在请求会议音频访问…"];
    __weak typeof(self) weakSelf = self;
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO
                                               onScreenWindowsOnly:NO
                                                 completionHandler:^(SCShareableContent *content, NSError *contentError) {
        if (contentError || content.displays.count == 0) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (weakSelf.shuttingDown || generation != weakSelf.recordingSessionGeneration || !weakSelf.startingRecording) return;
                weakSelf.startingRecording = NO;
                weakSelf.recordButton.enabled = YES;
                [weakSelf renderState:TranscriptionStateFailed message:[weakSelf english:@"Allow screen and system audio recording, then try again" chinese:@"请允许屏幕与系统音频录制后重试"]];
            });
            return;
        }

        if (weakSelf.shuttingDown || generation != weakSelf.recordingSessionGeneration || !weakSelf.startingRecording) return;

        SCDisplay *selectedDisplay = content.displays.firstObject;
        CGDirectDisplayID mainDisplayID = CGMainDisplayID();
        for (SCDisplay *display in content.displays) {
            if (display.displayID == mainDisplayID) {
                selectedDisplay = display;
                break;
            }
        }

        SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:selectedDisplay excludingWindows:@[]];
        SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
        configuration.capturesAudio = YES;
        configuration.excludesCurrentProcessAudio = YES;
        configuration.sampleRate = 48000;
        configuration.channelCount = 2;
        configuration.width = 2;
        configuration.height = 2;
        configuration.minimumFrameInterval = CMTimeMake(1, 1);

        NSError *directoryError = nil;
        NSURL *directory = [NSFileManager.defaultManager.temporaryDirectory URLByAppendingPathComponent:@"SnackRecord" isDirectory:YES];
        [NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:&directoryError];
        weakSelf.systemAudioURL = [directory URLByAppendingPathComponent:[NSString stringWithFormat:@"system-%@.m4a", NSUUID.UUID.UUIDString]];
        [[NSFileManager defaultManager] removeItemAtURL:weakSelf.systemAudioURL error:nil];

        NSError *writerError = nil;
        weakSelf.systemAudioWriter = [[AVAssetWriter alloc] initWithURL:weakSelf.systemAudioURL fileType:AVFileTypeAppleM4A error:&writerError];
        NSDictionary *settings = @{
            AVFormatIDKey: @(kAudioFormatMPEG4AAC),
            AVSampleRateKey: @48000,
            AVNumberOfChannelsKey: @2,
            AVEncoderBitRateKey: @128000,
        };
        weakSelf.systemAudioWriterInput = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeAudio outputSettings:settings];
        weakSelf.systemAudioWriterInput.expectsMediaDataInRealTime = YES;
        if (writerError || ![weakSelf.systemAudioWriter canAddInput:weakSelf.systemAudioWriterInput]) {
            [weakSelf failStartingSystemAudio:[weakSelf english:@"Unable to prepare meeting audio" chinese:@"无法准备会议音频文件"]];
            return;
        }
        [weakSelf.systemAudioWriter addInput:weakSelf.systemAudioWriterInput];
        weakSelf.systemAudioWriterStarted = NO;

        weakSelf.screenStream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:weakSelf];
        NSError *outputError = nil;
        if (![weakSelf.screenStream addStreamOutput:weakSelf type:SCStreamOutputTypeAudio sampleHandlerQueue:weakSelf.screenAudioQueue error:&outputError]) {
            [weakSelf failStartingSystemAudio:[weakSelf english:@"Unable to capture system audio" chinese:@"无法读取会议音频"]];
            return;
        }
        [weakSelf.screenStream startCaptureWithCompletionHandler:^(NSError *startError) {
            dispatch_async(dispatch_get_main_queue(), ^{
                if (weakSelf.shuttingDown || generation != weakSelf.recordingSessionGeneration || !weakSelf.startingRecording) return;
                if (startError) {
                    [weakSelf failStartingSystemAudio:[weakSelf english:@"Allow screen and system audio recording, then try again" chinese:@"请允许屏幕与系统音频录制后重试"]];
                } else {
                    weakSelf.recordButton.enabled = YES;
                    [weakSelf beginAudioCaptureForGeneration:generation];
                }
            });
        }];
    }];
}

- (void)failStartingSystemAudio:(NSString *)message {
    dispatch_async(dispatch_get_main_queue(), ^{
        SCStream *stream = self.screenStream;
        self.screenStream = nil;
        if (stream) [stream stopCaptureWithCompletionHandler:nil];
        [self.systemAudioWriter cancelWriting];
        self.systemAudioWriter = nil;
        self.systemAudioWriterInput = nil;
        self.systemAudioURL = nil;
        self.recordingMeetingAudio = NO;
        self.startingRecording = NO;
        if (self.shuttingDown) return;
        self.recordButton.enabled = YES;
        [self renderState:TranscriptionStateFailed message:message];
    });
}

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
    if (self.shuttingDown || stream != self.screenStream || type != SCStreamOutputTypeAudio || !CMSampleBufferDataIsReady(sampleBuffer)) return;
    if (!self.systemAudioWriterStarted) {
        if (![self.systemAudioWriter startWriting]) return;
        [self.systemAudioWriter startSessionAtSourceTime:CMSampleBufferGetPresentationTimeStamp(sampleBuffer)];
        self.systemAudioWriterStarted = YES;
    }
    if (self.systemAudioWriterInput.readyForMoreMediaData) {
        [self.systemAudioWriterInput appendSampleBuffer:sampleBuffer];
    }
}

- (void)stream:(SCStream *)stream didStopWithError:(NSError *)error {
    if (!self.shuttingDown && stream == self.screenStream && !self.finalizingMeetingAudio) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self stopRecordingIfNeeded];
            [self renderState:TranscriptionStateFailed message:[self english:@"System audio capture was interrupted" chinese:@"会议音频采集已中断"]];
        });
    }
}

- (void)refreshMicrophoneAuthorization {
    AVAuthorizationStatus status = [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (self.waitingForMicrophonePermission && status == AVAuthorizationStatusAuthorized) {
        self.waitingForMicrophonePermission = NO;
        [self renderState:TranscriptionStateReady message:nil];
    }
}

- (void)beginAudioCaptureForGeneration:(NSUInteger)generation {
    if (self.shuttingDown || generation != self.recordingSessionGeneration || !self.startingRecording) return;
    NSError *error = nil;
    NSURL *directory = [NSFileManager.defaultManager.temporaryDirectory URLByAppendingPathComponent:@"SnackRecord" isDirectory:YES];
    [NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:&error];
    if (error) {
        [self cancelPendingRecordingStart];
        [self renderState:TranscriptionStateFailed message:[self english:@"Unable to create a temporary recording file" chinese:@"无法创建临时录音文件"]];
        return;
    }

    self.recordingURL = [directory URLByAppendingPathComponent:[NSString stringWithFormat:@"recording-%@.wav", NSUUID.UUID.UUIDString]];
    AVAudioInputNode *input = self.audioEngine.inputNode;
    if (self.microphoneTapInstalled) {
        [input removeTapOnBus:0];
        self.microphoneTapInstalled = NO;
    }
    [self.audioEngine reset];
    AVAudioFormat *format = [input outputFormatForBus:0];
    self.audioFile = [[AVAudioFile alloc] initForWriting:self.recordingURL settings:format.settings commonFormat:format.commonFormat interleaved:format.isInterleaved error:&error];
    if (error || !self.audioFile) {
        [self cancelPendingRecordingStart];
        [self renderState:TranscriptionStateFailed message:[self english:@"Unable to prepare recording" chinese:@"无法准备录音"]];
        return;
    }

    static const NSInteger SnackRecordMaxTapRetries = 5;
    __weak typeof(self) weakSelf = self;
    NSInteger retries = 0;
    BOOL tapInstalled = NO;
    while (!tapInstalled && retries < SnackRecordMaxTapRetries) {
        @try {
            if (retries > 0) [NSThread sleepForTimeInterval:0.3];
            [input removeTapOnBus:0];
            [input installTapOnBus:0 bufferSize:2048 format:format block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
                if (weakSelf.shuttingDown || generation != weakSelf.recordingSessionGeneration) return;
                NSError *writeError = nil;
                [weakSelf.audioFile writeFromBuffer:buffer error:&writeError];
                if (writeError) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        [weakSelf renderState:TranscriptionStateFailed message:[weakSelf english:@"Unable to write recording" chinese:@"录音写入失败"]];
                    });
                }
            }];
            self.microphoneTapInstalled = YES;
            tapInstalled = YES;
        } @catch (NSException *exception) {
            retries++;
            if (retries >= SnackRecordMaxTapRetries) {
                [self cancelPendingRecordingStart];
                [self renderState:TranscriptionStateFailed message:[self english:@"Microphone is still being released. Please try again." chinese:@"麦克风仍在释放，请稍后重试。"]];
                return;
            }
        }
    }

    [self.audioEngine prepare];
    if (![self.audioEngine startAndReturnError:&error]) {
        [self cancelPendingRecordingStart];
        [self renderState:TranscriptionStateFailed message:[self english:@"Unable to start recording" chinese:@"无法开始录音"]];
        return;
    }
    self.recordingActivity = SnackRecordBeginRecordingActivity((id<SnackRecordingActivityManaging>)NSProcessInfo.processInfo);
    self.startingRecording = NO;
    self.recordButton.enabled = YES;
    self.recordingStartDate = NSDate.date;
    [self renderState:TranscriptionStateRecording message:nil];
}

- (void)cancelPendingRecordingStart {
    self.recordingSessionGeneration += 1;
    self.startingRecording = NO;
    self.recordingMeetingAudio = NO;
    self.recordButton.enabled = YES;
    SnackRecordEndRecordingActivity((id<SnackRecordingActivityManaging>)NSProcessInfo.processInfo, self.recordingActivity);
    self.recordingActivity = nil;
    if (self.microphoneTapInstalled) [self.audioEngine.inputNode removeTapOnBus:0];
    self.microphoneTapInstalled = NO;
    [self.audioEngine stop];
    [self.audioEngine reset];
    self.audioFile = nil;
    self.recordingURL = nil;
    self.recordingStartDate = nil;
    SCStream *stream = self.screenStream;
    self.screenStream = nil;
    [self.systemAudioWriter cancelWriting];
    self.systemAudioWriter = nil;
    self.systemAudioWriterInput = nil;
    self.systemAudioURL = nil;
    self.systemAudioWriterStarted = NO;
    if (stream) [stream stopCaptureWithCompletionHandler:nil];
    [self renderState:TranscriptionStateReady message:[self english:@"Recording start cancelled" chinese:@"已取消开始录音"]];
}

- (void)stopRecording {
    if (self.stoppingRecording || self.finalizingMeetingAudio) return;
    self.recordingSessionGeneration += 1;
    self.stoppingRecording = YES;
    self.recordButton.enabled = NO;
    NSURL *microphoneURL = self.recordingURL;
    NSDate *startDate = self.recordingStartDate ?: NSDate.date;
    BOOL wasMeetingRecording = self.recordingMeetingAudio;
    SnackRecordEndRecordingActivity((id<SnackRecordingActivityManaging>)NSProcessInfo.processInfo, self.recordingActivity);
    self.recordingActivity = nil;
    if (self.microphoneTapInstalled) [self.audioEngine.inputNode removeTapOnBus:0];
    self.microphoneTapInstalled = NO;
    [self.audioEngine stop];
    [self.audioEngine reset];
    self.audioFile = nil;
    if (!microphoneURL) {
        self.stoppingRecording = NO;
        self.recordButton.enabled = YES;
        [self renderState:TranscriptionStateFailed message:[self english:@"Recording file was not found" chinese:@"未找到录音文件"]];
        return;
    }

    self.recordingURL = nil;
    self.recordingStartDate = nil;
    if (wasMeetingRecording && self.screenStream) {
        self.finalizingMeetingAudio = YES;
        self.mixingMeetingAudio = NO;
        [self renderState:TranscriptionStateReady message:[self english:@"Preparing meeting audio…" chinese:@"正在整理会议音频…"]];
        self.recordButton.enabled = NO;
        __weak typeof(self) weakSelf = self;
        [self.screenStream stopCaptureWithCompletionHandler:^(NSError *stopError) {
            dispatch_async(weakSelf.screenAudioQueue, ^{
                [weakSelf finishSystemAudioRecordingWithMicrophoneURL:microphoneURL startDate:startDate];
            });
        }];
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(15 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            if (!weakSelf.finalizingMeetingAudio || weakSelf.mixingMeetingAudio) return;
            [weakSelf.systemAudioWriter cancelWriting];
            [weakSelf finishMeetingPreparationWithURL:microphoneURL
                                            startDate:startDate
                                              message:[weakSelf english:@"System audio finalization timed out; microphone audio was saved"
                                                                chinese:@"系统音频收尾超时，已保存麦克风录音"]];
        });
        return;
    }

    self.recordingMeetingAudio = NO;
    [self enqueueRecordingURL:microphoneURL startDate:startDate suggestedFilename:[self consumePendingSuggestedFilename]];
    [self unlockRecordingControlAfterDelay];
}

- (void)finishSystemAudioRecordingWithMicrophoneURL:(NSURL *)microphoneURL startDate:(NSDate *)startDate {
    if (!self.finalizingMeetingAudio) return;
    AVAssetWriter *writer = self.systemAudioWriter;
    if (!self.systemAudioWriterStarted || writer.status != AVAssetWriterStatusWriting) {
        [writer cancelWriting];
        dispatch_async(dispatch_get_main_queue(), ^{
            [self finishMeetingPreparationWithURL:microphoneURL startDate:startDate message:[self english:@"No system audio detected; transcribing microphone audio" chinese:@"未检测到系统声音，已转写麦克风"]];
        });
        return;
    }

    [self.systemAudioWriterInput markAsFinished];
    __weak typeof(self) weakSelf = self;
    [writer finishWritingWithCompletionHandler:^{
        if (!weakSelf.finalizingMeetingAudio) return;
        weakSelf.mixingMeetingAudio = YES;
        [weakSelf mixMicrophoneURL:microphoneURL systemURL:weakSelf.systemAudioURL startDate:startDate];
    }];
}

- (void)mixMicrophoneURL:(NSURL *)microphoneURL systemURL:(NSURL *)systemURL startDate:(NSDate *)startDate {
    if (!self.finalizingMeetingAudio || !systemURL) return;
    NSURL *combinedURL = [[microphoneURL URLByDeletingLastPathComponent] URLByAppendingPathComponent:[NSString stringWithFormat:@"meeting-%@.wav", NSUUID.UUID.UUIDString]];
    NSString *ffmpegPath = FFmpegExecutablePath();
    if (!ffmpegPath) {
        dispatch_async(dispatch_get_main_queue(), ^{
            [self finishMeetingPreparationWithURL:systemURL startDate:startDate message:[self english:@"FFmpeg not found; transcribing system audio" chinese:@"未找到 FFmpeg，已转写系统声音"]];
        });
        return;
    }
    NSTask *mixTask = [[NSTask alloc] init];
    mixTask.executableURL = [NSURL fileURLWithPath:ffmpegPath];
    mixTask.arguments = @[@"-y", @"-i", microphoneURL.path, @"-i", systemURL.path,
                          @"-filter_complex", @"[0:a][1:a]amix=inputs=2:duration=longest:normalize=1",
                          @"-ac", @"1", @"-ar", @"16000", combinedURL.path];
    mixTask.standardOutput = [NSPipe pipe];
    mixTask.standardError = [NSPipe pipe];
    NSError *launchError = nil;
    BOOL launched = [mixTask launchAndReturnError:&launchError];
    if (launched) [mixTask waitUntilExit];
    NSURL *resultURL = launched && mixTask.terminationStatus == 0 ? combinedURL : systemURL;
    NSString *message = resultURL == combinedURL
        ? [self english:@"Meeting audio added to the transcription queue" chinese:@"会议音频已加入转写任务"]
        : [self english:@"Audio mixing failed; transcribing system audio" chinese:@"混音失败，已转写系统声音"];
    dispatch_async(dispatch_get_main_queue(), ^{
        [self finishMeetingPreparationWithURL:resultURL startDate:startDate message:message];
    });
}

- (void)finishMeetingPreparationWithURL:(NSURL *)recordingURL startDate:(NSDate *)startDate message:(NSString *)message {
    if (!self.finalizingMeetingAudio) return;
    self.screenStream = nil;
    self.systemAudioWriter = nil;
    self.systemAudioWriterInput = nil;
    self.systemAudioURL = nil;
    self.systemAudioWriterStarted = NO;
    self.recordingMeetingAudio = NO;
    self.mixingMeetingAudio = NO;
    self.finalizingMeetingAudio = NO;
    [self enqueueRecordingURL:recordingURL startDate:startDate suggestedFilename:[self consumePendingSuggestedFilename]];
    [self renderState:TranscriptionStateReady message:message];
    [self unlockRecordingControlAfterDelay];
}

- (void)unlockRecordingControlAfterDelay {
    __weak typeof(self) weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.8 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (weakSelf.audioEngine.isRunning || weakSelf.finalizingMeetingAudio) return;
        weakSelf.stoppingRecording = NO;
        weakSelf.recordButton.enabled = YES;
    });
}

- (NSString *)consumePendingSuggestedFilename {
    NSString *filename = self.pendingSuggestedFilename;
    self.pendingSuggestedFilename = nil;
    return filename;
}

- (void)enqueueRecordingURL:(NSURL *)recordingURL startDate:(NSDate *)startDate suggestedFilename:(NSString *)suggestedFilename {
    NSString *identifier = NSUUID.UUID.UUIDString;
    NSString *extension = recordingURL.pathExtension.length > 0 ? recordingURL.pathExtension : @"wav";
    NSURL *cachedURL = [self.recordingsDirectory URLByAppendingPathComponent:[NSString stringWithFormat:@"%@.%@", identifier, extension]];
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSError *copyError = nil;
        [NSFileManager.defaultManager copyItemAtURL:recordingURL toURL:cachedURL error:&copyError];
        dispatch_async(dispatch_get_main_queue(), ^{
            if (copyError) {
                [self renderState:TranscriptionStateFailed message:[self english:@"Unable to cache the audio file" chinese:@"无法缓存本地音频文件"]];
                return;
            }
            [self createJobWithIdentifier:identifier recordingURL:cachedURL startDate:startDate suggestedFilename:suggestedFilename];
            if (self.meetilyExportHandler) {
                self.meetilyExportHandler(cachedURL, suggestedFilename ?: [self defaultFilenameForDate:startDate]);
            }
        });
    });
}

- (void)createJobWithIdentifier:(NSString *)identifier recordingURL:(NSURL *)recordingURL startDate:(NSDate *)startDate suggestedFilename:(NSString *)suggestedFilename {
    TranscriptionJob *job = [[TranscriptionJob alloc] init];
    job.identifier = identifier;
    job.recordingURL = recordingURL;
    job.startDate = startDate;
    job.state = TranscriptionJobStateQueued;
    job.transcriptionMode = self.transcriptionMode ?: TranscriptionModeFast;
    job.progress = 0.0;
    job.temporaryOutputURL = [[job.recordingURL URLByDeletingLastPathComponent] URLByAppendingPathComponent:[NSString stringWithFormat:@"result-%@.txt", NSUUID.UUID.UUIDString]];
    job.filenameField = [[NSTextField alloc] init];
    job.filenameField.stringValue = suggestedFilename ?: [self defaultFilenameForDate:job.startDate];
    job.filenameField.delegate = self;
    [self.jobs insertObject:job atIndex:0];
    [self trimJobHistoryIfNeeded];
    [self persistJobs];
    [self rebuildJobsView];

    [self renderState:TranscriptionStateReady message:[self english:@"Added to the queue. You can record again." chinese:@"已加入转写任务，可以继续录音"]];
    [self transcribeJob:job];
}

- (NSString *)defaultFilenameForDate:(NSDate *)date {
    NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
    formatter.locale = [[NSLocale alloc] initWithLocaleIdentifier:@"zh_CN"];
    formatter.dateFormat = @"yyyyMMdd-HHmmss";
    return [NSString stringWithFormat:@"Snack Record-%@.txt", [formatter stringFromDate:date]];
}

- (void)updateProgress:(double)progress forJob:(TranscriptionJob *)job {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (job.cancelled || job.state != TranscriptionJobStateProcessing) return;
        job.progress = MAX(job.progress, MIN(100.0, progress));
        if (!job.estimationStartedAt && job.progress >= 8.0) {
            job.estimationStartedAt = NSDate.date;
            job.estimationStartProgress = job.progress;
        }
        [self updateJobRow:job];
    });
}

- (NSMutableDictionary<NSString *, NSString *> *)workerEnvironment {
    NSMutableDictionary<NSString *, NSString *> *environment = [NSProcessInfo.processInfo.environment mutableCopy];
    NSString *modelCache = [[SnackRecordApplicationSupportURL() URLByAppendingPathComponent:@"Models"] path];
    if (HasCompleteModelCacheAtPath(modelCache)) {
        environment[@"MODELSCOPE_CACHE"] = modelCache;
    } else {
        [environment removeObjectForKey:@"MODELSCOPE_CACHE"];
    }
    environment[@"PYTHONUNBUFFERED"] = @"1";
    NSString *ffmpeg = FFmpegExecutablePath();
    if (ffmpeg) environment[@"FFMPEG_PATH"] = ffmpeg;
    return environment;
}

- (void)clearWorkerReferences {
    self.modelWorkerTask = nil;
    self.modelWorkerInput = nil;
    self.modelWorkerOutput = nil;
    self.modelWorkerReadBuffer = nil;
}

- (NSString *)readWorkerLine {
    if (!self.modelWorkerOutput) return nil;
    if (!self.modelWorkerReadBuffer) self.modelWorkerReadBuffer = [NSMutableData data];
    NSData *newlineData = [@"\n" dataUsingEncoding:NSUTF8StringEncoding];
    while (YES) {
        NSRange searchRange = NSMakeRange(0, self.modelWorkerReadBuffer.length);
        NSRange newline = [self.modelWorkerReadBuffer rangeOfData:newlineData options:0 range:searchRange];
        if (newline.location != NSNotFound) {
            NSData *lineData = [self.modelWorkerReadBuffer subdataWithRange:NSMakeRange(0, newline.location)];
            [self.modelWorkerReadBuffer replaceBytesInRange:NSMakeRange(0, NSMaxRange(newline)) withBytes:NULL length:0];
            return [[NSString alloc] initWithData:lineData encoding:NSUTF8StringEncoding];
        }
        NSData *chunk = self.modelWorkerOutput.availableData;
        if (chunk.length == 0) return nil;
        [self.modelWorkerReadBuffer appendData:chunk];
    }
}

- (NSDictionary *)readWorkerEvent {
    while (self.modelWorkerTask.isRunning || self.modelWorkerReadBuffer.length > 0) {
        NSString *line = [self readWorkerLine];
        if (!line) return nil;
        NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
        NSDictionary *event = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        if ([event isKindOfClass:NSDictionary.class]) return event;
    }
    return nil;
}

- (BOOL)startWorkerIfNeeded {
    if (self.modelWorkerTask.isRunning && self.modelWorkerInput && self.modelWorkerOutput) return YES;
    [self clearWorkerReferences];

    NSString *pythonExecutable = PythonExecutablePath();
    NSString *script = [NSBundle.mainBundle pathForResource:@"funasr_transcribe" ofType:@"py"];
    if (![NSFileManager.defaultManager isExecutableFileAtPath:pythonExecutable] || !script) return NO;

    NSTask *task = [[NSTask alloc] init];
    NSPipe *inputPipe = [NSPipe pipe];
    NSPipe *outputPipe = [NSPipe pipe];
    task.executableURL = [NSURL fileURLWithPath:pythonExecutable];
    task.arguments = @[script, @"--worker"];
    task.environment = [self workerEnvironment];
    task.standardInput = inputPipe;
    task.standardOutput = outputPipe;
    task.standardError = NSFileHandle.fileHandleWithNullDevice;
    NSError *launchError = nil;
    if (![task launchAndReturnError:&launchError]) return NO;

    self.modelWorkerTask = task;
    self.modelWorkerInput = inputPipe.fileHandleForWriting;
    self.modelWorkerOutput = outputPipe.fileHandleForReading;
    self.modelWorkerReadBuffer = [NSMutableData data];
    while (task.isRunning) {
        NSDictionary *event = [self readWorkerEvent];
        if (!event) break;
        if ([event[@"type"] isEqualToString:@"ready"]) return YES;
    }
    if (task.isRunning) [task terminate];
    [self clearWorkerReferences];
    return NO;
}

- (void)preloadModels {
    dispatch_async(self.transcriptionQueue, ^{ [self startWorkerIfNeeded]; });
}

- (void)shutdownWorker {
    if (self.modelWorkerTask.isRunning) [self.modelWorkerTask terminate];
}

- (BOOL)runWorkerRequest:(NSData *)requestData forJob:(TranscriptionJob *)job {
    if (![self startWorkerIfNeeded]) return NO;
    @try {
        [self.modelWorkerInput writeData:requestData];
    } @catch (NSException *exception) {
        return NO;
    }

    job.task = self.modelWorkerTask;
    BOOL completed = NO;
    while (self.modelWorkerTask.isRunning && !job.cancelled) {
        NSDictionary *event = [self readWorkerEvent];
        if (!event) break;
        if (![event[@"id"] isEqualToString:job.identifier]) continue;
        NSString *type = event[@"type"];
        if ([type isEqualToString:@"progress"]) {
            [self updateProgress:[event[@"percent"] doubleValue] forJob:job];
        } else if ([type isEqualToString:@"completed"]) {
            completed = YES;
            break;
        } else if ([type isEqualToString:@"error"]) {
            break;
        }
    }
    job.task = nil;
    return completed && [NSFileManager.defaultManager fileExistsAtPath:job.temporaryOutputURL.path];
}

- (void)transcribeJob:(TranscriptionJob *)job {
    dispatch_async(self.transcriptionQueue, ^{
        if (job.cancelled) return;
        dispatch_async(dispatch_get_main_queue(), ^{
            if (job.cancelled) return;
            job.state = TranscriptionJobStateProcessing;
            job.progress = 0.0;
            job.progressStartedAt = NSDate.date;
            job.estimationStartedAt = nil;
            job.estimationStartProgress = 0.0;
            [self updateJobRow:job];
            [self persistJobs];
        });

        if (![NSFileManager.defaultManager isExecutableFileAtPath:PythonExecutablePath()]) {
            [self failJob:job message:[self english:@"Local FunASR environment not found" chinese:@"未找到本地环境"]];
            return;
        }
        NSDateFormatter *startFormatter = [[NSDateFormatter alloc] init];
        startFormatter.locale = [[NSLocale alloc] initWithLocaleIdentifier:@"zh_CN"];
        startFormatter.dateFormat = @"yyyy-MM-dd HH:mm:ss";
        NSString *mode = [job.transcriptionMode isEqualToString:TranscriptionModeStandard]
            ? TranscriptionModeStandard
            : TranscriptionModeFast;
        NSDictionary *request = @{
            @"id": job.identifier,
            @"input": job.recordingURL.path,
            @"output": job.temporaryOutputURL.path,
            @"start_time": [startFormatter stringFromDate:job.startDate],
            @"mode": mode,
        };
        NSMutableData *requestData = [[NSJSONSerialization dataWithJSONObject:request options:0 error:nil] mutableCopy];
        [requestData appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
        BOOL completed = NO;
        for (NSInteger attempt = 0; attempt < 2 && !job.cancelled; attempt++) {
            completed = [self runWorkerRequest:requestData forJob:job];
            if (completed) break;
            [NSFileManager.defaultManager removeItemAtURL:job.temporaryOutputURL error:nil];
            [self shutdownWorker];
            [self clearWorkerReferences];
            if (attempt == 0) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    job.progress = 0.0;
                    job.progressStartedAt = NSDate.date;
                    job.estimationStartedAt = nil;
                    job.estimationStartProgress = 0.0;
                    [self updateJobRow:job];
                });
            }
        }
        if (job.cancelled) {
            [NSFileManager.defaultManager removeItemAtURL:job.temporaryOutputURL error:nil];
            return;
        }
        if (!completed) {
            if (!self.modelWorkerTask.isRunning) [self clearWorkerReferences];
            [self failJob:job message:[self english:@"Transcription failed" chinese:@"转写失败"]];
            return;
        }

        dispatch_async(dispatch_get_main_queue(), ^{
            [self finishJob:job];
        });
    });
}

- (void)failJob:(TranscriptionJob *)job message:(NSString *)message {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (job.cancelled) return;
        job.state = TranscriptionJobStateFailed;
        job.stateLabel.stringValue = message;
        [self updateJobRow:job];
        [self persistJobs];
    });
}

- (NSString *)safeFilename:(NSString *)filename {
    NSString *trimmed = [filename stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    NSCharacterSet *invalid = [NSCharacterSet characterSetWithCharactersInString:@"/:\\"];
    NSArray<NSString *> *parts = [trimmed componentsSeparatedByCharactersInSet:invalid];
    NSString *safe = [parts componentsJoinedByString:@"-"];
    if (safe.length == 0) safe = [self defaultFilenameForDate:NSDate.date];
    if (![safe.pathExtension.lowercaseString isEqualToString:@"txt"]) safe = [safe stringByAppendingPathExtension:@"txt"];
    return safe;
}

- (NSURL *)configuredOutputDirectoryForDate:(NSDate *)date error:(NSError **)error {
    NSString *configuredPath = [NSUserDefaults.standardUserDefaults stringForKey:SnackRecordOutputDirectoryKey];
    NSURL *desktop = [NSFileManager.defaultManager URLsForDirectory:NSDesktopDirectory inDomains:NSUserDomainMask].firstObject;
    NSURL *directory = configuredPath.length > 0
        ? [NSURL fileURLWithPath:configuredPath.stringByExpandingTildeInPath isDirectory:YES]
        : desktop;
    if ([NSUserDefaults.standardUserDefaults boolForKey:SnackRecordDailyFolderKey]) {
        NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
        formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
        formatter.dateFormat = @"yyyy-MM-dd";
        directory = [directory URLByAppendingPathComponent:[formatter stringFromDate:date ?: NSDate.date] isDirectory:YES];
    }
    if (![NSFileManager.defaultManager createDirectoryAtURL:directory withIntermediateDirectories:YES attributes:nil error:error]) {
        return nil;
    }
    return directory;
}

- (NSURL *)availableOutputURLForFilename:(NSString *)filename error:(NSError **)error {
    NSURL *directory = [self configuredOutputDirectoryForDate:NSDate.date error:error];
    if (!directory) return nil;
    NSURL *candidate = [directory URLByAppendingPathComponent:filename];
    NSString *stem = filename.stringByDeletingPathExtension;
    NSInteger suffix = 2;
    while ([NSFileManager.defaultManager fileExistsAtPath:candidate.path]) {
        candidate = [directory URLByAppendingPathComponent:[NSString stringWithFormat:@"%@-%ld.txt", stem, (long)suffix++]];
    }
    return candidate;
}

- (void)finishJob:(TranscriptionJob *)job {
    if (job.cancelled) return;
    NSString *filename = [self safeFilename:job.filenameField.stringValue];
    job.filenameField.stringValue = filename;
    NSError *moveError = nil;
    NSURL *destination = [self availableOutputURLForFilename:filename error:&moveError];
    if (!destination) {
        job.state = TranscriptionJobStateFailed;
        job.stateLabel.stringValue = [self english:@"Unable to create output folder" chinese:@"无法创建保存目录"];
        [self updateJobRow:job];
        [self persistJobs];
        return;
    }
    [NSFileManager.defaultManager moveItemAtURL:job.temporaryOutputURL toURL:destination error:&moveError];
    if (moveError) {
        job.state = TranscriptionJobStateFailed;
        job.stateLabel.stringValue = [self english:@"Unable to save" chinese:@"保存失败"];
        [self updateJobRow:job];
        [self persistJobs];
        return;
    }
    job.finalOutputURL = destination;
    job.state = TranscriptionJobStateFinished;
    job.progress = 100.0;
    job.filenameField.stringValue = destination.lastPathComponent;
    [self updateJobRow:job];
    [self persistJobs];

    NSString *text = [NSString stringWithContentsOfURL:destination encoding:NSUTF8StringEncoding error:nil];
    if (text) {
        [NSPasteboard.generalPasteboard clearContents];
        [NSPasteboard.generalPasteboard setString:text forType:NSPasteboardTypeString];
    }
    [self sendCompletionNotificationForURL:destination];
    [self renderState:self.audioEngine.isRunning ? TranscriptionStateRecording : TranscriptionStateReady message:nil];
}

- (void)sendCompletionNotificationForURL:(NSURL *)outputURL {
    UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
    content.title = [self english:@"Transcription complete" chinese:@"转写完成"];
    NSString *folder = outputURL.URLByDeletingLastPathComponent.lastPathComponent;
    content.body = [self english:[NSString stringWithFormat:@"Saved %@ to %@", outputURL.lastPathComponent, folder]
                            chinese:[NSString stringWithFormat:@"%@ 已保存到 %@", outputURL.lastPathComponent, folder]];
    content.sound = UNNotificationSound.defaultSound;
    UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:NSUUID.UUID.UUIDString content:content trigger:nil];
    [UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:request withCompletionHandler:nil];
}

- (void)rebuildJobsView {
    self.clearJobsButton.enabled = self.jobs.count > 0;
    for (NSView *subview in self.jobsDocumentView.subviews.copy) [subview removeFromSuperview];
    CGFloat rowHeight = 78;
    CGFloat contentHeight = MAX(278, self.jobs.count * rowHeight);
    CGFloat contentWidth = MAX(460, self.jobsScrollView.contentSize.width);
    self.jobsDocumentView.frame = NSMakeRect(0, 0, contentWidth, contentHeight);

    if (self.jobs.count == 0) {
        NSTextField *empty = [NSTextField labelWithString:[self english:@"Recordings and imported files will appear here" chinese:@"录音结束后，转写任务会显示在这里"]];
        empty.textColor = NSColor.tertiaryLabelColor;
        empty.alignment = NSTextAlignmentCenter;
        empty.frame = NSMakeRect(30, 112, MAX(200, self.jobsDocumentView.bounds.size.width - 60), 22);
        empty.autoresizingMask = NSViewWidthSizable;
        [self.jobsDocumentView addSubview:empty];
        return;
    }

    [self.jobs enumerateObjectsUsingBlock:^(TranscriptionJob *job, NSUInteger index, BOOL *stop) {
        [self configureRowForJob:job y:index * rowHeight];
        [self.jobsDocumentView addSubview:job.rowView];
    }];
}

- (void)configureRowForJob:(TranscriptionJob *)job y:(CGFloat)y {
    CGFloat rowWidth = MAX(360, self.jobsDocumentView.bounds.size.width);
    job.rowView = [[TaskCardView alloc] initWithFrame:NSMakeRect(0, y + 4, rowWidth, 70)];
    job.rowView.autoresizingMask = NSViewWidthSizable;

    job.filenameField.frame = NSMakeRect(14, 34, rowWidth - 154, 24);
    job.filenameField.autoresizingMask = NSViewWidthSizable;
    job.filenameField.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
    job.filenameField.placeholderString = [self english:@"Transcript filename.txt" chinese:@"转写文件名.txt"];
    job.filenameField.toolTip = [self english:@"Rename before transcription finishes" chinese:@"可在转写完成前修改保存文件名"];
    [job.rowView addSubview:job.filenameField];

    job.progressIndicator = [[NSProgressIndicator alloc] initWithFrame:NSMakeRect(15, 11, 14, 14)];
    job.progressIndicator.style = NSProgressIndicatorStyleSpinning;
    job.progressIndicator.controlSize = NSControlSizeSmall;
    [job.rowView addSubview:job.progressIndicator];

    job.stateLabel = [NSTextField labelWithString:@""];
    job.stateLabel.font = [NSFont systemFontOfSize:11];
    job.stateLabel.textColor = NSColor.secondaryLabelColor;
    job.stateLabel.frame = NSMakeRect(36, 8, rowWidth - 176, 19);
    job.stateLabel.autoresizingMask = NSViewWidthSizable;
    [job.rowView addSubview:job.stateLabel];

    job.revealButton = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:@"doc.text" accessibilityDescription:@"打开转写文件"] target:self action:@selector(openJobOutput:)];
    job.revealButton.bezelStyle = NSBezelStyleTexturedRounded;
    job.revealButton.imagePosition = NSImageOnly;
    job.revealButton.toolTip = [self english:@"Open transcript" chinese:@"打开转写文件"];
    job.revealButton.contentTintColor = BrandTeal();
    job.revealButton.tag = [self.jobs indexOfObjectIdenticalTo:job];
    job.revealButton.frame = NSMakeRect(rowWidth - 94, 31, 34, 30);
    job.revealButton.autoresizingMask = NSViewMinXMargin;
    [job.rowView addSubview:job.revealButton];

    job.retryButton = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:@"arrow.clockwise" accessibilityDescription:@"重新转写"] target:self action:@selector(retryJob:)];
    job.retryButton.bezelStyle = NSBezelStyleTexturedRounded;
    job.retryButton.imagePosition = NSImageOnly;
    job.retryButton.toolTip = [self english:@"Transcribe again" chinese:@"重新转写"];
    job.retryButton.contentTintColor = NSColor.systemBlueColor;
    job.retryButton.identifier = job.identifier;
    job.retryButton.frame = NSMakeRect(rowWidth - 134, 31, 34, 30);
    job.retryButton.autoresizingMask = NSViewMinXMargin;
    [job.rowView addSubview:job.retryButton];

    job.meetingNotesButton = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:@"sparkles" accessibilityDescription:@"生成会议纪要"] target:self action:@selector(createMeetingNotes:)];
    job.meetingNotesButton.bezelStyle = NSBezelStyleTexturedRounded;
    job.meetingNotesButton.imagePosition = NSImageOnly;
    job.meetingNotesButton.toolTip = [self english:@"Create meeting notes in Snack" chinese:@"在 Snack 中生成会议纪要"];
    job.meetingNotesButton.contentTintColor = BrandOrange();
    job.meetingNotesButton.identifier = job.identifier;
    job.meetingNotesButton.frame = NSMakeRect(rowWidth - 54, 31, 34, 30);
    job.meetingNotesButton.autoresizingMask = NSViewMinXMargin;
    [job.rowView addSubview:job.meetingNotesButton];
    [self updateJobRow:job];
}

- (NSString *)remainingTimeText:(NSTimeInterval)seconds {
    NSInteger total = MAX(1, (NSInteger)ceil(seconds));
    NSInteger hours = total / 3600;
    NSInteger minutes = (total % 3600) / 60;
    NSInteger remainingSeconds = total % 60;
    if ([self isChineseInterface]) {
        if (hours > 0) return [NSString stringWithFormat:@"%ld小时%ld分钟", (long)hours, (long)minutes];
        if (minutes > 0) return [NSString stringWithFormat:@"%ld分%ld秒", (long)minutes, (long)remainingSeconds];
        return [NSString stringWithFormat:@"%ld秒", (long)remainingSeconds];
    }
    if (hours > 0) return [NSString stringWithFormat:@"%ldh %ldm", (long)hours, (long)minutes];
    if (minutes > 0) return [NSString stringWithFormat:@"%ldm %lds", (long)minutes, (long)remainingSeconds];
    return [NSString stringWithFormat:@"%lds", (long)remainingSeconds];
}

- (NSString *)processingTextForJob:(TranscriptionJob *)job {
    BOOL standard = [job.transcriptionMode isEqualToString:TranscriptionModeStandard];
    NSString *modeName = standard
        ? [self english:@"Standard" chinese:@"标准转写"]
        : [self english:@"Fast" chinese:@"快速转写"];
    NSInteger percent = MAX(0, MIN(99, (NSInteger)llround(job.progress)));
    if (percent < 8 || !job.progressStartedAt) {
        return [self english:[NSString stringWithFormat:@"%@ %ld%% · Preparing models…", modeName, (long)percent]
                         chinese:[NSString stringWithFormat:@"%@ %ld%% · 正在准备模型…", modeName, (long)percent]];
    }
    NSTimeInterval elapsed = job.estimationStartedAt ? [NSDate.date timeIntervalSinceDate:job.estimationStartedAt] : 0.0;
    double completedSinceEstimate = job.progress - job.estimationStartProgress;
    if (elapsed < 2.0 || completedSinceEstimate < 1.0) {
        return [self english:[NSString stringWithFormat:@"%@ %ld%% · Calculating remaining time…", modeName, (long)percent]
                         chinese:[NSString stringWithFormat:@"%@ %ld%% · 正在计算剩余时间…", modeName, (long)percent]];
    }
    NSTimeInterval remaining = (100.0 - job.progress) / (completedSinceEstimate / elapsed);
    NSString *duration = [self remainingTimeText:remaining];
    return [self english:[NSString stringWithFormat:@"%@ %ld%% · About %@ remaining", modeName, (long)percent, duration]
                     chinese:[NSString stringWithFormat:@"%@ %ld%% · 预计剩余 %@", modeName, (long)percent, duration]];
}

- (NSURL *)snackApplicationURL {
    NSURL *registered = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:@"cn.yaowutech.snack"];
    if (registered && [NSFileManager.defaultManager fileExistsAtPath:registered.path]) return registered;

    NSArray<NSString *> *candidates = @[
        @"~/Desktop/Snack.app",
        @"~/Applications/Snack.app",
        @"/Applications/Snack.app",
    ];
    for (NSString *candidate in candidates) {
        NSString *path = candidate.stringByExpandingTildeInPath;
        NSBundle *bundle = [NSBundle bundleWithPath:path];
        if ([bundle.bundleIdentifier isEqualToString:@"cn.yaowutech.snack"] &&
            [NSFileManager.defaultManager fileExistsAtPath:path]) {
            return [NSURL fileURLWithPath:path isDirectory:YES];
        }
    }
    return nil;
}

- (NSString *)sha256ForData:(NSData *)data {
    unsigned char digest[CC_SHA256_DIGEST_LENGTH];
    CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *checksum = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
    for (NSUInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
        [checksum appendFormat:@"%02x", digest[index]];
    }
    return checksum;
}

- (NSString *)handoffTimestampForDate:(NSDate *)date {
    NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
    formatter.formatOptions = NSISO8601DateFormatWithInternetDateTime;
    return [formatter stringFromDate:date];
}

- (void)showMeetingNotesError:(NSString *)message {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleWarning;
    alert.messageText = [self english:@"Unable to open meeting notes" chinese:@"无法生成会议纪要"];
    alert.informativeText = message;
    [alert addButtonWithTitle:[self english:@"OK" chinese:@"知道了"]];
    [alert beginSheetModalForWindow:self.window completionHandler:nil];
}

- (void)showToast:(NSString *)message {
    [self.toastPanel orderOut:nil];

    NSRect windowFrame = self.window.frame;
    NSSize size = NSMakeSize(190, 42);
    NSRect frame = NSMakeRect(NSMidX(windowFrame) - size.width / 2.0,
                              NSMinY(windowFrame) + 54,
                              size.width,
                              size.height);
    NSPanel *panel = [[NSPanel alloc] initWithContentRect:frame
                                                styleMask:NSWindowStyleMaskBorderless
                                                  backing:NSBackingStoreBuffered
                                                    defer:NO];
    panel.opaque = NO;
    panel.backgroundColor = NSColor.clearColor;
    panel.hasShadow = YES;
    panel.level = NSFloatingWindowLevel;
    panel.ignoresMouseEvents = YES;
    panel.collectionBehavior = NSWindowCollectionBehaviorTransient | NSWindowCollectionBehaviorMoveToActiveSpace;

    NSVisualEffectView *background = [[NSVisualEffectView alloc] initWithFrame:NSMakeRect(0, 0, size.width, size.height)];
    background.material = NSVisualEffectMaterialHUDWindow;
    background.blendingMode = NSVisualEffectBlendingModeWithinWindow;
    background.state = NSVisualEffectStateActive;
    background.wantsLayer = YES;
    background.layer.cornerRadius = 8;
    background.layer.masksToBounds = YES;

    NSTextField *label = [NSTextField labelWithString:message];
    label.frame = NSMakeRect(12, 11, size.width - 24, 20);
    label.alignment = NSTextAlignmentCenter;
    label.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
    label.textColor = NSColor.whiteColor;
    [background addSubview:label];
    panel.contentView = background;

    self.toastPanel = panel;
    [panel orderFrontRegardless];
    __weak typeof(self) weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.8 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (weakSelf.toastPanel != panel) return;
        [panel orderOut:nil];
        weakSelf.toastPanel = nil;
    });
}

- (void)showSnackInstallationPrompt {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleInformational;
    alert.messageText = [self english:@"Snack Desktop is required" chinese:@"需要安装 Snack.app"];
    alert.informativeText = [self english:@"Install Snack Desktop to generate meeting notes from a transcript."
                                     chinese:@"安装 Snack 桌面端后，才能将转写文本自动生成会议纪要。"];
    [alert addButtonWithTitle:[self english:@"Copy GitHub address" chinese:@"复制 GitHub 地址"]];
    [alert addButtonWithTitle:[self english:@"Not now" chinese:@"暂不安装"]];
    __weak typeof(self) weakSelf = self;
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse returnCode) {
        if (returnCode != NSAlertFirstButtonReturn) return;
        [NSPasteboard.generalPasteboard clearContents];
        [NSPasteboard.generalPasteboard setString:SnackDesktopGitHubURL forType:NSPasteboardTypeString];
        [weakSelf showToast:[weakSelf english:@"GitHub address copied" chinese:@"GitHub 地址已复制"]];
    }];
}

- (void)createMeetingNotes:(NSButton *)sender {
    TranscriptionJob *job = nil;
    for (TranscriptionJob *candidate in self.jobs) {
        if ([candidate.identifier isEqualToString:sender.identifier]) {
            job = candidate;
            break;
        }
    }
    NSURL *snackURL = [self snackApplicationURL];
    BOOL outputAvailable = job.finalOutputURL && [NSFileManager.defaultManager fileExistsAtPath:job.finalOutputURL.path];
    if (!job || job.state != TranscriptionJobStateFinished || !outputAvailable) {
        [self refreshIntegrationAvailability];
        return;
    }
    if (!snackURL) {
        [self showSnackInstallationPrompt];
        return;
    }

    NSError *readError = nil;
    NSString *transcript = [NSString stringWithContentsOfURL:job.finalOutputURL encoding:NSUTF8StringEncoding error:&readError];
    if (!transcript) {
        [self showMeetingNotesError:[self english:@"The transcript file could not be read." chinese:@"无法读取转写文本文件。"]];
        return;
    }

    NSString *prompt = [NSUserDefaults.standardUserDefaults stringForKey:SnackRecordMeetingPromptKey];
    if (prompt.length == 0) prompt = SnackRecordDefaultMeetingPrompt;
    NSString *handoffText = [NSString stringWithFormat:@"%@\n\n%@", prompt, transcript];
    NSData *handoffData = [handoffText dataUsingEncoding:NSUTF8StringEncoding];
    if (handoffData.length == 0 || handoffData.length > SnackRecordMaximumHandoffBytes) {
        [self showMeetingNotesError:[self english:@"The prompt and transcript exceed Snack Desktop's 5 MB handoff limit."
                                            chinese:@"Prompt 与转写文本超过 Snack 桌面端 5 MB 的交接上限。"]];
        return;
    }
    NSDate *createdAt = NSDate.date;
    NSDictionary *metadata = @{
        @"version": @1,
        @"source": @"snack-record",
        @"createdAt": [self handoffTimestampForDate:createdAt],
        @"expiresAt": [self handoffTimestampForDate:[createdAt dateByAddingTimeInterval:300]],
        @"byteLength": @(handoffData.length),
        @"sha256": [self sha256ForData:handoffData],
        @"attachmentPath": job.finalOutputURL.path,
        @"attachmentName": job.finalOutputURL.lastPathComponent,
    };
    NSData *metadataData = [NSJSONSerialization dataWithJSONObject:metadata options:0 error:nil];
    if (!metadataData) {
        [self showMeetingNotesError:[self english:@"The handoff data could not be prepared." chinese:@"无法准备交接数据。"]];
        return;
    }

    NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
    [pasteboard declareTypes:@[NSPasteboardTypeString, SnackRecordHandoffMetadataType, NSPasteboardTypeFileURL] owner:nil];
    [pasteboard setString:handoffText forType:NSPasteboardTypeString];
    [pasteboard setData:metadataData forType:SnackRecordHandoffMetadataType];
    [pasteboard setString:job.finalOutputURL.absoluteString forType:NSPasteboardTypeFileURL];

    NSURL *deepLink = [NSURL URLWithString:@"snack://chat?source=clipboard"];
    if (![NSWorkspace.sharedWorkspace openURL:deepLink]) {
        [self showMeetingNotesError:[self english:@"Snack Desktop could not be opened." chinese:@"无法打开 Snack 桌面端。"]];
    }
}

- (void)refreshIntegrationAvailability {
    for (TranscriptionJob *job in self.jobs) {
        if (job.rowView) [self updateJobRow:job];
    }
}

- (void)updateJobRow:(TranscriptionJob *)job {
    BOOL audioAvailable = [NSFileManager.defaultManager fileExistsAtPath:job.recordingURL.path];
    BOOL outputAvailable = job.finalOutputURL && [NSFileManager.defaultManager fileExistsAtPath:job.finalOutputURL.path];
    BOOL snackAvailable = [self snackApplicationURL] != nil;
    job.retryButton.enabled = audioAvailable && job.state != TranscriptionJobStateQueued && job.state != TranscriptionJobStateProcessing;
    NSColor *retryColor = job.retryButton.enabled ? NSColor.systemBlueColor : NSColor.tertiaryLabelColor;
    job.retryButton.contentTintColor = retryColor;
    switch (job.state) {
        case TranscriptionJobStateQueued:
            job.stateLabel.frame = NSMakeRect(36, 8, job.rowView.bounds.size.width - 176, 19);
            job.stateLabel.stringValue = [self english:@"Waiting…" chinese:@"等待处理…"];
            job.stateLabel.textColor = NSColor.secondaryLabelColor;
            job.progressIndicator.hidden = NO;
            [job.progressIndicator startAnimation:nil];
            job.revealButton.enabled = NO;
            job.filenameField.editable = YES;
            break;
        case TranscriptionJobStateProcessing:
            job.stateLabel.frame = NSMakeRect(36, 8, job.rowView.bounds.size.width - 176, 19);
            job.stateLabel.stringValue = [self processingTextForJob:job];
            job.stateLabel.textColor = NSColor.secondaryLabelColor;
            job.progressIndicator.hidden = NO;
            [job.progressIndicator startAnimation:nil];
            job.revealButton.enabled = NO;
            job.filenameField.editable = YES;
            break;
        case TranscriptionJobStateFinished:
            job.stateLabel.frame = NSMakeRect(14, 8, job.rowView.bounds.size.width - 154, 19);
            job.stateLabel.stringValue = outputAvailable
                ? [self english:@"Complete · Local file available" chinese:@"已完成 · 本地有效"]
                : [self english:@"Complete · Local file missing" chinese:@"已完成 · 本地失效"];
            job.stateLabel.textColor = outputAvailable ? NSColor.systemGreenColor : NSColor.systemOrangeColor;
            [job.progressIndicator stopAnimation:nil];
            job.progressIndicator.hidden = YES;
            job.filenameField.editable = NO;
            job.revealButton.enabled = outputAvailable;
            break;
        case TranscriptionJobStateFailed:
            job.stateLabel.frame = NSMakeRect(14, 8, job.rowView.bounds.size.width - 154, 19);
            if (job.stateLabel.stringValue.length == 0) job.stateLabel.stringValue = [self english:@"Transcription failed" chinese:@"转写失败"];
            job.stateLabel.textColor = NSColor.systemOrangeColor;
            [job.progressIndicator stopAnimation:nil];
            job.progressIndicator.hidden = YES;
            job.filenameField.editable = YES;
            job.revealButton.enabled = outputAvailable;
            break;
    }
    job.revealButton.contentTintColor = job.revealButton.enabled ? BrandTeal() : NSColor.tertiaryLabelColor;
    job.revealButton.toolTip = outputAvailable
        ? [self english:@"Open transcript" chinese:@"打开转写文件"]
        : [self english:@"File not found" chinese:@"文件未找到"];
    job.meetingNotesButton.enabled = job.state == TranscriptionJobStateFinished && outputAvailable;
    job.meetingNotesButton.contentTintColor = job.meetingNotesButton.enabled ? BrandOrange() : NSColor.tertiaryLabelColor;
    if (job.state != TranscriptionJobStateFinished) {
        job.meetingNotesButton.toolTip = [self english:@"Available after transcription completes" chinese:@"转写完成后可生成会议纪要"];
    } else if (!outputAvailable) {
        job.meetingNotesButton.toolTip = [self english:@"Transcript file not found" chinese:@"转写文件未找到"];
    } else if (!snackAvailable) {
        job.meetingNotesButton.toolTip = [self english:@"Install Snack Desktop to create meeting notes" chinese:@"安装 Snack 桌面端后生成会议纪要"];
    } else {
        job.meetingNotesButton.toolTip = [self english:@"Create meeting notes in Snack" chinese:@"在 Snack 中生成会议纪要"];
    }
    if (!audioAvailable && job.state != TranscriptionJobStateProcessing) {
        job.retryButton.enabled = NO;
        job.retryButton.toolTip = [self english:@"Audio cache not found" chinese:@"音频缓存未找到"];
        job.stateLabel.stringValue = [self english:@"Audio cache missing · Local data invalid" chinese:@"音频缓存丢失 · 本地失效"];
        job.stateLabel.textColor = NSColor.systemOrangeColor;
    }
}

- (void)openJobOutput:(NSButton *)sender {
    NSInteger index = sender.tag;
    if (index >= 0 && index < (NSInteger)self.jobs.count) {
        TranscriptionJob *job = self.jobs[index];
        if (!job.finalOutputURL || ![NSFileManager.defaultManager fileExistsAtPath:job.finalOutputURL.path]) {
            NSAlert *alert = [[NSAlert alloc] init];
            alert.alertStyle = NSAlertStyleWarning;
            alert.messageText = [self english:@"File not found" chinese:@"文件未找到"];
            alert.informativeText = [self english:@"The transcript was moved or deleted. You can transcribe the cached audio again." chinese:@"桌面上的转写文件可能已被移动或删除，可以使用缓存音频重新转写。"];
            [alert addButtonWithTitle:[self english:@"OK" chinese:@"知道了"]];
            [alert beginSheetModalForWindow:self.window completionHandler:nil];
            [self updateJobRow:job];
            [self persistJobs];
            return;
        }
        [NSWorkspace.sharedWorkspace openURL:job.finalOutputURL];
    }
}

- (void)retryJob:(NSButton *)sender {
    TranscriptionJob *job = nil;
    for (TranscriptionJob *candidate in self.jobs) {
        if ([candidate.identifier isEqualToString:sender.identifier]) {
            job = candidate;
            break;
        }
    }
    if (!job) return;
    if (![NSFileManager.defaultManager fileExistsAtPath:job.recordingURL.path]) {
        [self updateJobRow:job];
        return;
    }
    job.state = TranscriptionJobStateQueued;
    job.cancelled = NO;
    job.transcriptionMode = self.transcriptionMode ?: TranscriptionModeFast;
    job.progress = 0.0;
    job.progressStartedAt = nil;
    job.estimationStartedAt = nil;
    job.estimationStartProgress = 0.0;
    job.temporaryOutputURL = [self.storageDirectory URLByAppendingPathComponent:[NSString stringWithFormat:@"result-%@.txt", NSUUID.UUID.UUIDString]];
    job.filenameField.editable = YES;
    job.progressIndicator.hidden = NO;
    job.stateLabel.stringValue = @"";
    job.stateLabel.textColor = NSColor.secondaryLabelColor;
    [self updateJobRow:job];
    [self persistJobs];
    [self transcribeJob:job];
}

- (void)controlTextDidEndEditing:(NSNotification *)notification {
    NSTextField *field = notification.object;
    for (TranscriptionJob *job in self.jobs) {
        if (job.filenameField == field) {
            [self persistJobs];
            break;
        }
    }
}

- (BOOL)hasPendingTranscriptions {
    for (TranscriptionJob *job in self.jobs) {
        if (!job.cancelled && (job.state == TranscriptionJobStateQueued || job.state == TranscriptionJobStateProcessing)) return YES;
    }
    return NO;
}

- (BOOL)hasActiveWork {
    return SnackRecordShouldProtectActiveWork(self.audioEngine.isRunning, self.finalizingMeetingAudio, [self hasPendingTranscriptions]);
}

- (void)cancelTranscriptions {
    for (TranscriptionJob *job in self.jobs) {
        if (job.task.isRunning) [job.task terminate];
    }
}

- (void)shutdownForApplicationTerminationWithCompletion:(dispatch_block_t)completion {
    if (self.shuttingDown) {
        if (completion) completion();
        return;
    }
    self.shuttingDown = YES;
    self.recordingSessionGeneration += 1;
    self.startingRecording = NO;
    self.stoppingRecording = YES;

    [self.recordingTimer invalidate];
    self.recordingTimer = nil;
    [self.recordingPanel orderOut:nil];

    SnackRecordEndRecordingActivity((id<SnackRecordingActivityManaging>)NSProcessInfo.processInfo, self.recordingActivity);
    self.recordingActivity = nil;
    if (self.microphoneTapInstalled) [self.audioEngine.inputNode removeTapOnBus:0];
    self.microphoneTapInstalled = NO;
    [self.audioEngine stop];
    [self.audioEngine reset];
    self.audioFile = nil;
    self.recordingURL = nil;
    self.recordingStartDate = nil;

    SCStream *stream = self.screenStream;
    self.screenStream = nil;
    [self.systemAudioWriter cancelWriting];
    self.systemAudioWriter = nil;
    self.systemAudioWriterInput = nil;
    self.systemAudioURL = nil;
    self.systemAudioWriterStarted = NO;
    self.recordingMeetingAudio = NO;
    self.finalizingMeetingAudio = NO;
    self.mixingMeetingAudio = NO;

    [self cancelTranscriptions];
    [self shutdownWorker];

    if (!stream) {
        if (completion) completion();
        return;
    }

    __block BOOL stopFinished = NO;
    void (^finish)(void) = ^{
        dispatch_async(dispatch_get_main_queue(), ^{
            if (stopFinished) return;
            stopFinished = YES;
            if (completion) completion();
        });
    };
    [stream stopCaptureWithCompletionHandler:^(__unused NSError *error) { finish(); }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)), dispatch_get_main_queue(), finish);
}

- (void)renderState:(TranscriptionState)state message:(NSString *)message {
    self.currentState = state;
    NSString *symbol = @"mic.fill";
    NSString *status = message ?: [self english:@"Click record or press Control+R to start" chinese:@"点击录音或按 Control+R 开始"];
    NSString *tooltip = [self english:@"Start meeting recording (Control+R)" chinese:@"开始会议录音（Control+R）"];
    switch (state) {
        case TranscriptionStateRecording:
            symbol = @"stop.fill";
            status = [self english:@"Recording system audio and microphone" chinese:@"正在录制系统音频与麦克风"];
            tooltip = [self english:@"Stop and transcribe" chinese:@"停止录音并转写"];
            self.recordingTitleLabel.stringValue = [self english:@"Recording meeting" chinese:@"正在录制会议"];
            break;
        case TranscriptionStateFinished:
            symbol = @"mic.fill";
            status = message ?: [self english:@"Transcript saved to Desktop" chinese:@"转写已保存到桌面"];
            break;
        case TranscriptionStateFailed:
            symbol = @"exclamationmark.triangle";
            status = message ?: [self english:@"Something went wrong. Please try again." chinese:@"出现错误，请重试"];
            break;
        case TranscriptionStateReady:
            break;
    }

    self.statusLabel.stringValue = status;
    self.recordButton.image = [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:tooltip];
    self.recordButton.toolTip = tooltip;
    self.recordButton.layer.backgroundColor = (state == TranscriptionStateRecording ? NSColor.systemRedColor : BrandOrange()).CGColor;
    self.recordButton.contentTintColor = NSColor.whiteColor;
    self.recordButton.enabled = YES;
    if (state == TranscriptionStateRecording) [self showRecordingCard]; else [self hideRecordingCard];
    if (self.stateDidChange) self.stateDidChange(state);
}

@end

@interface MeetingReminderMonitor : NSObject <SCStreamOutput, SCStreamDelegate>
@property(nonatomic) BOOL enabled;
@property(nonatomic) BOOL recordingActive;
@property(nonatomic) BOOL fullAutomatic;
@property(nonatomic) BOOL probeStarting;
@property(nonatomic) BOOL probeMicTapInstalled;
@property(nonatomic) BOOL probeStreamOutputInstalled;
@property(nonatomic) double activeAudioSeconds;
@property(nonatomic, copy) NSString *interfaceLanguage;
@property(nonatomic, copy) NSString *probeBundleIdentifier;
@property(nonatomic, copy) NSString *detectedApplicationName;
@property(nonatomic, copy) NSString *detectedWindowTitle;
@property(nonatomic, copy) NSString *recordedMeetingBundleIdentifier;
@property(nonatomic, strong) NSDate *cooldownUntil;
@property(nonatomic, strong) NSTimer *pollTimer;
@property(nonatomic, strong) NSTimer *dismissTimer;
@property(nonatomic, strong) AVAudioEngine *probeEngine;
@property(nonatomic, strong) SCStream *probeStream;
@property(nonatomic, strong) dispatch_queue_t probeAudioQueue;
@property(nonatomic, strong) NSPanel *reminderPanel;
@property(nonatomic, strong) NSTextField *reminderTitleLabel;
@property(nonatomic, strong) NSTextField *reminderBodyLabel;
@property(nonatomic, strong) NSButton *startButton;
@property(nonatomic, copy) void (^startRecordingHandler)(void);
@property(nonatomic, copy) void (^stopRecordingHandler)(void);
- (void)setMonitoringEnabled:(BOOL)enabled;
- (void)setRecordingActive:(BOOL)recordingActive;
- (void)applyInterfaceLanguage:(NSString *)language;
- (void)stop;
- (void)stopWithCompletion:(dispatch_block_t)completion;
- (void)stopProbeWithCompletion:(dispatch_block_t)completion;
@end

@implementation MeetingReminderMonitor

- (instancetype)init {
    self = [super init];
    if (self) {
        _interfaceLanguage = @"zh";
        [self configureReminderPanel];
    }
    return self;
}

- (NSDictionary<NSString *, NSString *> *)monitoredApplications {
    return @{
        @"com.tencent.wwmapp": @"企业微信",
        @"com.electron.lark": @"飞书",
        @"com.bytedance.ee.lark": @"飞书",
        @"com.tencent.meeting": @"腾讯会议",
        @"com.tencent.wemeet": @"腾讯会议",
        @"us.zoom.xos": @"Zoom",
        @"com.apple.Safari": @"浏览器会议",
        @"com.google.Chrome": @"浏览器会议",
        @"com.microsoft.edgemac": @"浏览器会议",
        @"org.mozilla.firefox": @"浏览器会议",
    };
}

- (BOOL)isBrowserBundleIdentifier:(NSString *)bundleIdentifier {
    return [bundleIdentifier isEqualToString:@"com.apple.Safari"] ||
        [bundleIdentifier isEqualToString:@"com.google.Chrome"] ||
        [bundleIdentifier isEqualToString:@"com.microsoft.edgemac"] ||
        [bundleIdentifier isEqualToString:@"org.mozilla.firefox"];
}

- (BOOL)isWeComBundleIdentifier:(NSString *)bundleIdentifier {
    return [bundleIdentifier isEqualToString:@"com.tencent.wwmapp"];
}

- (BOOL)isDedicatedMeetingBundleIdentifier:(NSString *)bundleIdentifier {
    return [bundleIdentifier isEqualToString:@"us.zoom.xos"] ||
        [bundleIdentifier isEqualToString:@"com.tencent.meeting"] ||
        [bundleIdentifier isEqualToString:@"com.tencent.wemeet"];
}

- (BOOL)isChineseInterface {
    return [self.interfaceLanguage isEqualToString:@"zh"];
}

- (void)configureReminderPanel {
    self.reminderPanel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 326, 116)
                                                    styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                                      backing:NSBackingStoreBuffered
                                                        defer:NO];
    self.reminderPanel.opaque = NO;
    self.reminderPanel.backgroundColor = NSColor.clearColor;
    self.reminderPanel.hasShadow = YES;
    self.reminderPanel.level = NSStatusWindowLevel;
    self.reminderPanel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
    self.reminderPanel.becomesKeyOnlyIfNeeded = YES;

    NSVisualEffectView *card = [[NSVisualEffectView alloc] initWithFrame:NSMakeRect(0, 0, 326, 116)];
    card.material = NSVisualEffectMaterialHUDWindow;
    card.blendingMode = NSVisualEffectBlendingModeWithinWindow;
    card.state = NSVisualEffectStateActive;
    card.wantsLayer = YES;
    card.layer.cornerRadius = 10;
    card.layer.masksToBounds = YES;
    self.reminderPanel.contentView = card;

    NSImageView *icon = [[NSImageView alloc] initWithFrame:NSMakeRect(18, 73, 24, 24)];
    icon.image = [NSImage imageWithSystemSymbolName:@"video.fill" accessibilityDescription:@"会议录音提醒"];
    icon.contentTintColor = BrandOrange();
    [card addSubview:icon];

    self.reminderTitleLabel = [NSTextField labelWithString:@""];
    self.reminderTitleLabel.font = [NSFont systemFontOfSize:13 weight:NSFontWeightSemibold];
    self.reminderTitleLabel.frame = NSMakeRect(52, 78, 224, 20);
    [card addSubview:self.reminderTitleLabel];

    self.reminderBodyLabel = [NSTextField wrappingLabelWithString:@""];
    self.reminderBodyLabel.font = [NSFont systemFontOfSize:11];
    self.reminderBodyLabel.textColor = NSColor.secondaryLabelColor;
    self.reminderBodyLabel.frame = NSMakeRect(52, 43, 250, 34);
    [card addSubview:self.reminderBodyLabel];

    self.startButton = [NSButton buttonWithTitle:@"" target:self action:@selector(startRecordingFromReminder:)];
    self.startButton.bezelStyle = NSBezelStyleRounded;
    self.startButton.bezelColor = BrandOrange();
    self.startButton.contentTintColor = NSColor.whiteColor;
    self.startButton.font = [NSFont systemFontOfSize:11 weight:NSFontWeightSemibold];
    self.startButton.frame = NSMakeRect(196, 10, 110, 28);
    [card addSubview:self.startButton];

    NSButton *dismissButton = [NSButton buttonWithImage:[NSImage imageWithSystemSymbolName:@"xmark" accessibilityDescription:@"关闭提醒"] target:self action:@selector(dismissReminder:)];
    dismissButton.bezelStyle = NSBezelStyleInline;
    dismissButton.imagePosition = NSImageOnly;
    dismissButton.contentTintColor = NSColor.secondaryLabelColor;
    dismissButton.frame = NSMakeRect(287, 80, 24, 24);
    [card addSubview:dismissButton];
    [self updateReminderPanelText];
}

- (void)updateReminderPanelText {
    BOOL chinese = [self isChineseInterface];
    self.reminderTitleLabel.stringValue = chinese ? @"会议录音提醒" : @"Meeting recording reminder";
    NSString *applicationName = self.detectedApplicationName ?: (chinese ? @"会议应用" : @"meeting app");
    self.reminderBodyLabel.stringValue = chinese
        ? [NSString stringWithFormat:@"检测到 %@ 可能正在进行会议，是否开始录音？", applicationName]
        : [NSString stringWithFormat:@"Audio activity suggests a meeting in %@. Start recording?", applicationName];
    self.startButton.title = chinese ? @"开始录音" : @"Start recording";
}

- (void)applyInterfaceLanguage:(NSString *)language {
    self.interfaceLanguage = [language isEqualToString:@"zh"] ? @"zh" : @"en";
    [self updateReminderPanelText];
}

- (void)setMonitoringEnabled:(BOOL)enabled {
    _enabled = enabled;
    [self.pollTimer invalidate];
    self.pollTimer = nil;
    if (!enabled) {
        [self stopProbe];
        [self hideReminder];
        return;
    }
    self.pollTimer = [NSTimer scheduledTimerWithTimeInterval:8.0 target:self selector:@selector(pollForMeeting:) userInfo:nil repeats:YES];
    [[NSRunLoop mainRunLoop] addTimer:self.pollTimer forMode:NSRunLoopCommonModes];
    [self pollForMeeting:nil];
}

- (void)setRecordingActive:(BOOL)recordingActive {
    _recordingActive = recordingActive;
    if (recordingActive) {
        [self stopProbe];
        [self hideReminder];
    } else {
        self.recordedMeetingBundleIdentifier = nil;
        if (self.fullAutomatic) {
            self.cooldownUntil = [NSDate dateWithTimeIntervalSinceNow:120];
        }
        if (self.enabled) [self pollForMeeting:nil];
    }
}

- (void)stop {
    [self stopWithCompletion:nil];
}

- (void)stopWithCompletion:(dispatch_block_t)completion {
    _enabled = NO;
    _recordingActive = NO;
    [self.pollTimer invalidate];
    self.pollTimer = nil;
    [self hideReminder];
    [self stopProbeWithCompletion:completion];
}

- (void)pollForMeeting:(NSTimer *)timer {
    if (!self.enabled) return;

    NSDictionary<NSString *, NSString *> *applications = [self monitoredApplications];
    NSMutableSet<NSString *> *runningBundleIdentifiers = [NSMutableSet set];
    for (NSRunningApplication *application in NSWorkspace.sharedWorkspace.runningApplications) {
        if (applications[application.bundleIdentifier]) [runningBundleIdentifiers addObject:application.bundleIdentifier];
    }

    if (self.recordingActive) {
        if (self.fullAutomatic && self.recordedMeetingBundleIdentifier) {
            if (![runningBundleIdentifiers containsObject:self.recordedMeetingBundleIdentifier]) {
                self.recordedMeetingBundleIdentifier = nil;
                if (self.stopRecordingHandler) self.stopRecordingHandler();
            } else if (!self.probeStarting) {
                self.probeStarting = YES;
                __weak typeof(self) weakSelf = self;
                [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                                           onScreenWindowsOnly:NO
                                                             completionHandler:^(SCShareableContent *content, NSError *contentError) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        typeof(self) strongSelf = weakSelf;
                        if (!strongSelf) return;
                        strongSelf.probeStarting = NO;
                        if (!strongSelf.enabled || !strongSelf.recordingActive) return;
                        if (contentError || content.displays.count == 0) return;
                        BOOL stillMeeting = NO;
                        for (SCWindow *window in content.windows) {
                            NSString *bundleIdentifier = window.owningApplication.bundleIdentifier;
                            if ([bundleIdentifier isEqualToString:strongSelf.recordedMeetingBundleIdentifier] &&
                                [strongSelf windowSuggestsMeeting:window bundleIdentifier:bundleIdentifier]) {
                                stillMeeting = YES;
                                break;
                            }
                        }
                        if (!stillMeeting) {
                            NSLog(@"Snack Record meeting window no longer visible; stopping recording");
                            strongSelf.recordedMeetingBundleIdentifier = nil;
                            if (strongSelf.stopRecordingHandler) strongSelf.stopRecordingHandler();
                        }
                    });
                }];
            }
        }
        return;
    }
    if (self.reminderPanel.isVisible) return;
    if (self.cooldownUntil && [self.cooldownUntil timeIntervalSinceNow] > 0) return;
    if (runningBundleIdentifiers.count == 0) {
        [self stopProbe];
        return;
    }
    if (self.probeStarting) return;

    self.probeStarting = YES;
    __weak typeof(self) weakSelf = self;
    [SCShareableContent getShareableContentExcludingDesktopWindows:YES
                                               onScreenWindowsOnly:NO
                                                 completionHandler:^(SCShareableContent *content, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            typeof(self) strongSelf = weakSelf;
            if (!strongSelf) return;
            strongSelf.probeStarting = NO;
            if (!strongSelf.enabled || strongSelf.recordingActive || error || content.displays.count == 0) {
                if (error) NSLog(@"Snack Record poll error: %@", error.localizedDescription);
                return;
            }
            if (strongSelf.probeStream || strongSelf.probeEngine) {
                BOOL meetingWindowStillVisible = NO;
                for (SCWindow *window in content.windows) {
                    NSString *bundleIdentifier = window.owningApplication.bundleIdentifier;
                    if ([bundleIdentifier isEqualToString:strongSelf.probeBundleIdentifier] &&
                        [strongSelf windowSuggestsMeeting:window bundleIdentifier:bundleIdentifier]) {
                        meetingWindowStillVisible = YES;
                        break;
                    }
                }
                if (!meetingWindowStillVisible) [strongSelf stopProbe];
            }
            [strongSelf dumpWindowsForContent:content];
            [strongSelf startProbeForContent:content runningBundleIdentifiers:runningBundleIdentifiers];
        });
    }];
}

- (void)dumpWindowsForContent:(SCShareableContent *)content {
    @try {
        NSString *path = @"/tmp/snackrecord-windows.txt";
        NSMutableString *dump = [NSMutableString stringWithFormat:@"-- %@ --\n", NSDate.date];
        NSDictionary<NSString *, NSString *> *applications = [self monitoredApplications];
        for (SCWindow *window in content.windows) {
            NSString *bundleIdentifier = window.owningApplication.bundleIdentifier;
            if (!applications[bundleIdentifier]) continue;
            [dump appendFormat:@"bundle=%@ title=[%@] frame=(%.0f,%.0f,%.0f,%.0f) onscreen=%d\n",
                bundleIdentifier, window.title ?: @"", CGRectGetMinX(window.frame), CGRectGetMinY(window.frame),
                CGRectGetWidth(window.frame), CGRectGetHeight(window.frame), window.isOnScreen];
        }
        NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
        if (!handle) {
            [dump writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
        } else {
            [handle seekToEndOfFile];
            [handle writeData:[dump dataUsingEncoding:NSUTF8StringEncoding]];
            [handle closeFile];
        }
    } @catch (NSException *exception) {}
}

- (BOOL)windowSuggestsMeeting:(SCWindow *)window bundleIdentifier:(NSString *)bundleIdentifier {
    NSString *title = window.title.lowercaseString ?: @"";
    if ([self isHomeWindowTitle:title forBundleIdentifier:bundleIdentifier]) return NO;
    NSArray<NSString *> *keywords = @[@"会议", @"通话", @"meeting", @"call", @"conference", @"zoom", @"teams", @"meet", @"钉钉", @"webinar"];
    for (NSString *keyword in keywords) {
        if ([title containsString:keyword]) return YES;
    }
    BOOL feishu = [bundleIdentifier isEqualToString:@"com.electron.lark"] ||
        [bundleIdentifier isEqualToString:@"com.bytedance.ee.lark"];
    if (feishu) return NO;
    CGFloat width = CGRectGetWidth(window.frame);
    CGFloat height = CGRectGetHeight(window.frame);
    if ([self isDedicatedMeetingBundleIdentifier:bundleIdentifier]) {
        // SCShareableContent reports isOnScreen=0 for some meeting apps
        // (notably 腾讯会议) even while a real in-meeting window is visible,
        // so isOnScreen is unreliable here. The app's home/launcher window
        // has already been rejected above by isHomeWindowTitle; a non-home
        // title at this size is the in-meeting window.
        return width >= 800 && height >= 500;
    }
    return NO;
}

- (BOOL)isHomeWindowTitle:(NSString *)title forBundleIdentifier:(NSString *)bundleIdentifier {
    if (title.length == 0) return NO;
    NSString *trimmed = [title stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (trimmed.length == 0) return NO;
    NSString *normalized = [self normalizeTitleForComparison:trimmed];
    NSArray<NSString *> *homeTitles = [self homeWindowTitlesForBundleIdentifier:bundleIdentifier];
    for (NSString *candidate in homeTitles) {
        if ([normalized isEqualToString:[self normalizeTitleForComparison:candidate]]) return YES;
    }
    return NO;
}

- (NSString *)normalizeTitleForComparison:(NSString *)title {
    NSCharacterSet *stripSet = [NSCharacterSet characterSetWithCharactersInString:@" -_·。:：.,|()[]【】（）"];
    NSArray<NSString *> *parts = [title componentsSeparatedByCharactersInSet:stripSet];
    return [[parts componentsJoinedByString:@""] lowercaseString];
}

- (NSArray<NSString *> *)homeWindowTitlesForBundleIdentifier:(NSString *)bundleIdentifier {
    if ([bundleIdentifier isEqualToString:@"com.tencent.wwmapp"]) {
        return @[@"企业微信", @"wechat work", @"微信工作版"];
    }
    if ([bundleIdentifier isEqualToString:@"com.tencent.meeting"] ||
        [bundleIdentifier isEqualToString:@"com.tencent.wemeet"]) {
        return @[@"腾讯会议", @"tencent meeting"];
    }
    if ([bundleIdentifier isEqualToString:@"us.zoom.xos"]) {
        return @[@"zoom", @"zoom meetings", @"zoom workplace"];
    }
    if ([bundleIdentifier isEqualToString:@"com.electron.lark"] ||
        [bundleIdentifier isEqualToString:@"com.bytedance.ee.lark"]) {
        return @[@"飞书", @"lark"];
    }
    return @[];
}

- (BOOL)isFrontmostApplicationMeeting {
    NSString *frontmostBundleIdentifier = NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier;
    if (!frontmostBundleIdentifier || !self.probeBundleIdentifier) return NO;
    return [frontmostBundleIdentifier isEqualToString:self.probeBundleIdentifier];
}

- (double)automaticTriggerThreshold {
    return [self isFrontmostApplicationMeeting] ? 6.0 : 30.0;
}

- (void)startProbeForContent:(SCShareableContent *)content runningBundleIdentifiers:(NSSet<NSString *> *)runningBundleIdentifiers {
    NSDictionary<NSString *, NSString *> *knownApplications = [self monitoredApplications];
    NSString *selectedBundleIdentifier = nil;
    SCWindow *selectedWindow = nil;
    for (SCWindow *window in content.windows) {
        NSString *bundleIdentifier = window.owningApplication.bundleIdentifier;
        if (![runningBundleIdentifiers containsObject:bundleIdentifier]) continue;
        if ([self windowSuggestsMeeting:window bundleIdentifier:bundleIdentifier]) {
            selectedBundleIdentifier = bundleIdentifier;
            selectedWindow = window;
            break;
        }
    }
    if (!selectedBundleIdentifier) {
        NSLog(@"Snack Record no meeting window found; monitored windows=%lu", (unsigned long)content.windows.count);
        [self logDedicatedMeetingCandidatesForContent:content runningBundleIdentifiers:runningBundleIdentifiers];
        [self dumpWindowsForContent:content];
        [self stopProbe];
        return;
    }
    NSLog(@"Snack Record probe selected bundle=%@ title=%@", selectedBundleIdentifier, selectedWindow.title ?: @"(nil)");
    [self dumpWindowsForContent:content];

    self.activeAudioSeconds = 0;
    self.probeBundleIdentifier = selectedBundleIdentifier;
    self.detectedApplicationName = knownApplications[selectedBundleIdentifier];
    self.detectedWindowTitle = selectedWindow ? selectedWindow.title : @"";
    [self startSystemAudioProbe];
}

- (void)logDedicatedMeetingCandidatesForContent:(SCShareableContent *)content
                       runningBundleIdentifiers:(NSSet<NSString *> *)runningBundleIdentifiers {
    // When no meeting window is found, explain why each window of a running
    // dedicated meeting app was rejected, so a real-meeting observation
    // unambiguously shows whether the in-meeting window appeared and what
    // title/size/onscreen it had.
    for (SCWindow *window in content.windows) {
        NSString *bundleIdentifier = window.owningApplication.bundleIdentifier;
        if (![runningBundleIdentifiers containsObject:bundleIdentifier]) continue;
        if (![self isDedicatedMeetingBundleIdentifier:bundleIdentifier]) continue;
        CGFloat width = CGRectGetWidth(window.frame);
        CGFloat height = CGRectGetHeight(window.frame);
        NSString *title = window.title ?: @"";
        NSString *reason = nil;
        if ([self isHomeWindowTitle:title forBundleIdentifier:bundleIdentifier]) {
            reason = @"home-title";
        } else if (width < 800 || height < 500) {
            reason = [NSString stringWithFormat:@"size %.0fx%.0f < 800x500", width, height];
        } else {
            reason = @"would-accept";
        }
        NSLog(@"Snack Record candidate bundle=%@ title=[%@] frame=(%.0f,%.0f,%.0f,%.0f) onscreen=%d reason=%@",
              bundleIdentifier, title, CGRectGetMinX(window.frame), CGRectGetMinY(window.frame),
              width, height, window.isOnScreen, reason);
    }
}

- (void)startSystemAudioProbe {
    if (self.probeStream) return;
    self.probeStarting = NO;
    if (!self.probeAudioQueue) {
        self.probeAudioQueue = dispatch_queue_create("com.snackrecord.probe.audio", DISPATCH_QUEUE_SERIAL);
    }
    __weak typeof(self) weakSelf = self;
    [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:NO completionHandler:^(SCShareableContent *content, NSError *error) {
        dispatch_async(dispatch_get_main_queue(), ^{
            typeof(self) strongSelf = weakSelf;
            if (!strongSelf) return;
            if (!strongSelf.enabled || strongSelf.recordingActive || error || content.displays.count == 0) {
                if (error) NSLog(@"Snack Record probe content error: %@", error.localizedDescription);
                return;
            }
            SCDisplay *selectedDisplay = content.displays.firstObject;
            CGDirectDisplayID mainDisplayID = CGMainDisplayID();
            for (SCDisplay *display in content.displays) {
                if (display.displayID == mainDisplayID) {
                    selectedDisplay = display;
                    break;
                }
            }
            SCContentFilter *filter = [[SCContentFilter alloc] initWithDisplay:selectedDisplay excludingWindows:@[]];
            SCStreamConfiguration *configuration = [[SCStreamConfiguration alloc] init];
            configuration.capturesAudio = YES;
            configuration.excludesCurrentProcessAudio = YES;
            configuration.sampleRate = 48000;
            configuration.channelCount = 2;
            configuration.width = 2;
            configuration.height = 2;
            configuration.minimumFrameInterval = CMTimeMake(1, 1);

            SCStream *stream = [[SCStream alloc] initWithFilter:filter configuration:configuration delegate:strongSelf];
            NSError *outputError = nil;
            if (![stream addStreamOutput:strongSelf type:SCStreamOutputTypeAudio sampleHandlerQueue:strongSelf.probeAudioQueue error:&outputError]) {
                NSLog(@"Snack Record system audio probe output failed: %@", outputError.localizedDescription);
                return;
            }
            strongSelf.probeStreamOutputInstalled = YES;
            strongSelf.probeStream = stream;
            [stream startCaptureWithCompletionHandler:^(NSError *startError) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (!weakSelf) return;
                    if (startError) {
                        NSLog(@"Snack Record system audio probe start failed: %@", startError.localizedDescription);
                        [weakSelf stopProbe];
                    } else {
                        NSLog(@"Snack Record system audio probe started");
                    }
                });
            }];
        });
    }];
}

- (void)stream:(SCStream *)stream didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeAudio || !CMSampleBufferDataIsReady(sampleBuffer)) return;
    double rms = [self rootMeanSquareForSampleBuffer:sampleBuffer];
    double duration = (double)CMTimeGetSeconds(CMSampleBufferGetDuration(sampleBuffer));
    if (duration <= 0) duration = 0.05;
    __weak typeof(self) weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
        typeof(self) strongSelf = weakSelf;
        if (!strongSelf || strongSelf.probeStream != stream || strongSelf.recordingActive || !strongSelf.enabled) return;
        if (rms >= 0.015) {
            strongSelf.activeAudioSeconds += duration;
        } else {
            strongSelf.activeAudioSeconds = MAX(0, strongSelf.activeAudioSeconds - duration * 0.5);
        }
        double threshold = strongSelf.fullAutomatic ? [strongSelf automaticTriggerThreshold] : 3.0;
        if ((long)(strongSelf.activeAudioSeconds * 2) % 10 == 0) {
            NSLog(@"Snack Record probe audio rms=%.4f active=%.1f threshold=%.1f", rms, strongSelf.activeAudioSeconds, threshold);
        }
        if (strongSelf.activeAudioSeconds >= threshold) {
            if (strongSelf.fullAutomatic) {
                strongSelf.recordedMeetingBundleIdentifier = strongSelf.probeBundleIdentifier;
                [strongSelf stopProbe];
                [strongSelf hideReminder];
                if (strongSelf.startRecordingHandler) strongSelf.startRecordingHandler();
            } else {
                [strongSelf showReminder];
            }
        }
    });
}

- (double)rootMeanSquareForSampleBuffer:(CMSampleBufferRef)sampleBuffer {
    if (!sampleBuffer || !CMSampleBufferDataIsReady(sampleBuffer)) return 0;
    CMBlockBufferRef blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer);
    if (!blockBuffer) return 0;
    CMAudioFormatDescriptionRef formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer);
    const AudioStreamBasicDescription *asbd = formatDescription ? CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) : NULL;
    BOOL isFloat = !asbd || (asbd->mFormatFlags & kAudioFormatFlagIsFloat) != 0;
    size_t lengthAtOffset = 0;
    size_t totalLength = 0;
    char *dataPointer = NULL;
    OSStatus status = CMBlockBufferGetDataPointer(blockBuffer, 0, &lengthAtOffset, &totalLength, &dataPointer);
    if (status != kCMBlockBufferNoErr || !dataPointer || totalLength < 4) return 0;
    double sum = 0;
    NSUInteger count = 0;
    if (isFloat) {
        const float *samples = (const float *)dataPointer;
        count = totalLength / sizeof(float);
        for (NSUInteger index = 0; index < count; index++) {
            float sample = samples[index];
            sum += sample * sample;
        }
    } else {
        const int16_t *samples = (const int16_t *)dataPointer;
        count = totalLength / sizeof(int16_t);
        for (NSUInteger index = 0; index < count; index++) {
            double sample = (double)samples[index] / 32768.0;
            sum += sample * sample;
        }
    }
    return count == 0 ? 0 : sqrt(sum / count);
}

- (double)rootMeanSquareForPCMBuffer:(AVAudioPCMBuffer *)buffer {
    if (!buffer || buffer.frameLength == 0) return 0;
    const float *samples = buffer.floatChannelData ? buffer.floatChannelData[0] : NULL;
    if (!samples) return 0;
    double sum = 0;
    NSUInteger count = buffer.frameLength;
    for (NSUInteger index = 0; index < count; index++) sum += samples[index] * samples[index];
    return sqrt(sum / count);
}

- (void)stopProbe {
    [self stopProbeWithCompletion:nil];
}

- (void)stopProbeWithCompletion:(dispatch_block_t)completion {
    self.probeStarting = NO;
    self.probeBundleIdentifier = nil;
    self.activeAudioSeconds = 0;
    AVAudioEngine *engine = self.probeEngine;
    self.probeEngine = nil;
    if (self.probeMicTapInstalled) {
        @try { [engine.inputNode removeTapOnBus:0]; } @catch (NSException *exception) {}
        self.probeMicTapInstalled = NO;
    }
    [engine stop];
    SCStream *stream = self.probeStream;
    self.probeStream = nil;
    self.probeStreamOutputInstalled = NO;
    if (stream) {
        [stream stopCaptureWithCompletionHandler:^(NSError *stopError) {
            if (completion) completion();
        }];
    } else {
        if (completion) completion();
    }
}

- (void)showReminder {
    if (!self.enabled || self.recordingActive || self.reminderPanel.isVisible) return;
    [self stopProbe];
    self.cooldownUntil = [NSDate dateWithTimeIntervalSinceNow:10 * 60];
    [self updateReminderPanelText];
    NSScreen *screen = NSScreen.mainScreen ?: NSScreen.screens.firstObject;
    NSRect visibleFrame = screen.visibleFrame;
    NSSize size = self.reminderPanel.frame.size;
    [self.reminderPanel setFrameOrigin:NSMakePoint(NSMaxX(visibleFrame) - size.width - 20,
                                                    NSMaxY(visibleFrame) - size.height - 20)];
    [self.reminderPanel orderFrontRegardless];
    [self.dismissTimer invalidate];
    self.dismissTimer = [NSTimer scheduledTimerWithTimeInterval:15.0 target:self selector:@selector(dismissReminder:) userInfo:nil repeats:NO];
}

- (void)hideReminder {
    [self.dismissTimer invalidate];
    self.dismissTimer = nil;
    [self.reminderPanel orderOut:nil];
}

- (void)dismissReminder:(id)sender {
    [self hideReminder];
}

- (void)startRecordingFromReminder:(id)sender {
    [self hideReminder];
    self.recordingActive = YES;
    if (self.startRecordingHandler) self.startRecordingHandler();
}

@end

@interface AppDelegate : NSObject <NSApplicationDelegate, UNUserNotificationCenterDelegate, NSTextViewDelegate>
@property(nonatomic, strong) TranscriptionController *controller;
@property(nonatomic, strong) NSStatusItem *statusItem;
@property(nonatomic, strong) NSImage *statusIcon;
@property(nonatomic, strong) NSMenuItem *startRecordingItem;
@property(nonatomic, strong) NSMenuItem *stopRecordingItem;
@property(nonatomic, strong) NSMenuItem *showWindowItem;
@property(nonatomic, strong) NSMenuItem *quitItem;
@property(nonatomic, strong) NSMenuItem *mainQuitItem;
@property(nonatomic, strong) NSMenuItem *interfaceLanguageItem;
@property(nonatomic, strong) NSMenuItem *englishInterfaceItem;
@property(nonatomic, strong) NSMenuItem *chineseInterfaceItem;
@property(nonatomic, strong) NSMenuItem *transcriptionModeItem;
@property(nonatomic, strong) NSMenuItem *fastTranscriptionItem;
@property(nonatomic, strong) NSMenuItem *standardTranscriptionItem;
@property(nonatomic, strong) NSMenuItem *recordingReminderItem;
@property(nonatomic, strong) NSMenuItem *meetilyIntegrationItem;
@property(nonatomic, strong) NSMenuItem *reminderOffItem;
@property(nonatomic, strong) NSMenuItem *reminderAutomaticItem;
@property(nonatomic, strong) NSMenuItem *reminderFullItem;
@property(nonatomic, strong) NSPanel *settingsPanel;
@property(nonatomic, strong) NSTextField *settingsTitleLabel;
@property(nonatomic, strong) NSTextField *settingsDescriptionLabel;
@property(nonatomic, strong) NSTextField *languageSettingLabel;
@property(nonatomic, strong) NSTextField *transcriptionSettingLabel;
@property(nonatomic, strong) NSTextField *reminderSettingLabel;
@property(nonatomic, strong) NSTextField *meetingPromptSettingLabel;
@property(nonatomic, strong) NSTextField *meetingPromptCountLabel;
@property(nonatomic, strong) NSTextField *outputFolderSettingLabel;
@property(nonatomic, strong) NSPopUpButton *languageSettingPopup;
@property(nonatomic, strong) NSPopUpButton *transcriptionSettingPopup;
@property(nonatomic, strong) NSPopUpButton *reminderSettingPopup;
@property(nonatomic, strong) NSScrollView *meetingPromptScrollView;
@property(nonatomic, strong) NSTextView *meetingPromptTextView;
@property(nonatomic, strong) NSTextField *outputFolderPathField;
@property(nonatomic, strong) NSButton *chooseOutputFolderButton;
@property(nonatomic, strong) NSButton *dailyFolderCheckbox;
@property(nonatomic, copy) NSString *interfaceLanguage;
@property(nonatomic, copy) NSString *transcriptionMode;
@property(nonatomic, copy) NSString *recordingReminderMode;
@property(nonatomic, strong) MeetingReminderMonitor *meetingReminderMonitor;
@property(nonatomic, strong) id shortcutMonitor;
@property(nonatomic) EventHotKeyRef recordingHotKey;
@property(nonatomic) EventHandlerRef hotKeyEventHandler;
@property(nonatomic) BOOL terminationCleanupInProgress;
- (void)handleGlobalRecordingShortcut;
@end

static const OSType SnackRecordHotKeySignature = 'SnRc';
static const UInt32 SnackRecordHotKeyIdentifier = 1;

static OSStatus HandleSnackRecordHotKey(EventHandlerCallRef nextHandler, EventRef event, void *userData) {
    EventHotKeyID hotKeyID = {0};
    OSStatus status = GetEventParameter(event, kEventParamDirectObject, typeEventHotKeyID,
                                        NULL, sizeof(hotKeyID), NULL, &hotKeyID);
    if (status == noErr && hotKeyID.signature == SnackRecordHotKeySignature &&
        hotKeyID.id == SnackRecordHotKeyIdentifier) {
        AppDelegate *delegate = (__bridge AppDelegate *)userData;
        dispatch_async(dispatch_get_main_queue(), ^{ [delegate handleGlobalRecordingShortcut]; });
        return noErr;
    }
    return CallNextEventHandler(nextHandler, event);
}

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    UNUserNotificationCenter.currentNotificationCenter.delegate = self;
    [UNUserNotificationCenter.currentNotificationCenter requestAuthorizationWithOptions:UNAuthorizationOptionAlert | UNAuthorizationOptionSound completionHandler:^(BOOL granted, NSError *error) {}];
    [NSUserDefaults.standardUserDefaults registerDefaults:@{
        @"SnackRecordInterfaceLanguage": @"zh",
        @"SnackRecordTranscriptionMode": TranscriptionModeFast,
        @"SnackRecordReminderMode": @"off",
        SnackRecordMeetingPromptKey: SnackRecordDefaultMeetingPrompt,
        SnackRecordOutputDirectoryKey: [NSFileManager.defaultManager URLsForDirectory:NSDesktopDirectory inDomains:NSUserDomainMask].firstObject.path,
        SnackRecordDailyFolderKey: @NO,
        @"SnackRecordMeetilyIntegration": @YES,
        @"SnackRecordMeetilyModel": @"large-v3-turbo-q5_0",
    }];
    if (![NSUserDefaults.standardUserDefaults boolForKey:@"SnackRecordChineseDefaultsApplied"]) {
        [NSUserDefaults.standardUserDefaults setObject:@"zh" forKey:@"SnackRecordInterfaceLanguage"];
        [NSUserDefaults.standardUserDefaults setBool:YES forKey:@"SnackRecordChineseDefaultsApplied"];
    }
    self.interfaceLanguage = [NSUserDefaults.standardUserDefaults stringForKey:@"SnackRecordInterfaceLanguage"] ?: @"en";
    self.transcriptionMode = [NSUserDefaults.standardUserDefaults stringForKey:@"SnackRecordTranscriptionMode"] ?: TranscriptionModeFast;
    self.recordingReminderMode = [NSUserDefaults.standardUserDefaults stringForKey:@"SnackRecordReminderMode"] ?: @"off";
    NSImage *applicationIcon = RoundedApplicationIcon();
    if (applicationIcon) NSApp.applicationIconImage = applicationIcon;
    self.controller = [[TranscriptionController alloc] init];
    [self.controller applyInterfaceLanguage:self.interfaceLanguage];
    [self.controller applyTranscriptionMode:self.transcriptionMode];
    self.meetingReminderMonitor = [[MeetingReminderMonitor alloc] init];
    [self.meetingReminderMonitor applyInterfaceLanguage:self.interfaceLanguage];
    __weak typeof(self) weakSelf = self;
    self.meetingReminderMonitor.startRecordingHandler = ^{
        weakSelf.controller.pendingSuggestedFilename = [weakSelf smartFilenameFromWindowTitle:weakSelf.meetingReminderMonitor.detectedWindowTitle];
        [weakSelf.controller startRecordingIfNeeded];
    };
    self.meetingReminderMonitor.stopRecordingHandler = ^{ [weakSelf.controller stopRecordingIfNeeded]; };
    self.controller.meetilyExportHandler = ^(NSURL *audioURL, NSString *title) {
        [weakSelf sendToMeetilyWithURL:audioURL title:title];
    };
    self.controller.showSettingsHandler = ^{ [weakSelf showSettings]; };
    self.controller.window.miniwindowImage = applicationIcon;
    self.controller.window.miniwindowTitle = @"Snack Record";
    [self configureStatusItem];
    [self configureMainMenu];
    [self configureSettingsPanel];
    self.controller.stateDidChange = ^(TranscriptionState state) {
        [weakSelf updateStatusItemForState:state];
        [weakSelf.meetingReminderMonitor setRecordingActive:state == TranscriptionStateRecording];
    };
    [self updateStatusItemForState:TranscriptionStateReady];
    [self configureShortcut];
    self.meetingReminderMonitor.fullAutomatic = [self.recordingReminderMode isEqualToString:@"full"];
    [self.meetingReminderMonitor setMonitoringEnabled:[self.recordingReminderMode isEqualToString:@"automatic"] || [self.recordingReminderMode isEqualToString:@"full"]];
    [self.controller showWindow];
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
       willPresentNotification:(UNNotification *)notification
         withCompletionHandler:(void (^)(UNNotificationPresentationOptions options))completionHandler {
    completionHandler(UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionSound);
}

- (void)configureShortcut {
    EventTypeSpec eventType = {kEventClassKeyboard, kEventHotKeyPressed};
    OSStatus handlerStatus = InstallApplicationEventHandler(&HandleSnackRecordHotKey, 1, &eventType,
                                                             (__bridge void *)self, &_hotKeyEventHandler);
    EventHotKeyID hotKeyID = {SnackRecordHotKeySignature, SnackRecordHotKeyIdentifier};
    OSStatus registrationStatus = handlerStatus == noErr
        ? RegisterEventHotKey(kVK_ANSI_R, controlKey, hotKeyID, GetApplicationEventTarget(),
                              0, &_recordingHotKey)
        : handlerStatus;
    if (registrationStatus == noErr) return;

    if (self.hotKeyEventHandler) {
        RemoveEventHandler(self.hotKeyEventHandler);
        self.hotKeyEventHandler = NULL;
    }
    __weak typeof(self) weakSelf = self;
    self.shortcutMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event) {
        NSEventModifierFlags modifiers = event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
        NSString *key = event.charactersIgnoringModifiers.lowercaseString;
        if (modifiers == NSEventModifierFlagControl && [key isEqualToString:@"r"]) {
            if (!weakSelf.controller.audioEngine.isRunning && !weakSelf.controller.startingRecording) {
                weakSelf.controller.pendingSuggestedFilename = [weakSelf tempMeetingTitle];
            }
            [weakSelf.controller toggleRecording];
            return nil;
        }
        return event;
    }];
}

- (void)handleGlobalRecordingShortcut {
    if (!self.controller.audioEngine.isRunning && !self.controller.startingRecording) {
        self.controller.pendingSuggestedFilename = [self tempMeetingTitle];
    }
    [self.controller toggleRecording];
}

- (NSString *)tempMeetingTitle {
    NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
    formatter.locale = [[NSLocale alloc] initWithLocaleIdentifier:@"zh_CN"];
    formatter.dateFormat = @"yyyy-MM-dd HH:mm";
    return [NSString stringWithFormat:@"会议 %@", [formatter stringFromDate:NSDate.date]];
}

- (NSImage *)menuBarTemplateIcon {
    NSImage *icon = RoundedApplicationIcon();
    icon.size = NSMakeSize(20, 20);
    icon.template = NO;
    return icon;
}

- (BOOL)isChineseInterface {
    return [self.interfaceLanguage isEqualToString:@"zh"];
}

- (NSString *)smartFilenameFromWindowTitle:(NSString *)title {
    if (title.length == 0) return nil;
    NSArray<NSString *> *stripTokens = @[
        @"腾讯会议", @"腾讯视频会议", @"会议", @"通话", @"meeting", @"call", @"conference",
        @"zoom", @"google meet", @"microsoft teams", @"钉钉", @"飞书", @"企业微信",
        @"wechat work", @"webinar", @"- 个人", @"(个人)", @"（个人）",
    ];
    NSMutableString *clean = [title mutableCopy];
    for (NSString *token in stripTokens) {
        [clean replaceOccurrencesOfString:token withString:@""
                                  options:NSCaseInsensitiveSearch
                                    range:NSMakeRange(0, clean.length)];
    }
    NSRegularExpression *urlPattern = [NSRegularExpression regularExpressionWithPattern:@"https?://\\S+" options:0 error:nil];
    [urlPattern replaceMatchesInString:clean options:0 range:NSMakeRange(0, clean.length) withTemplate:@" "];
    NSRegularExpression *bracketPattern = [NSRegularExpression regularExpressionWithPattern:@"[【】\\[\\]（）()]" options:0 error:nil];
    [bracketPattern replaceMatchesInString:clean options:0 range:NSMakeRange(0, clean.length) withTemplate:@""];
    NSRegularExpression *digitsPattern = [NSRegularExpression regularExpressionWithPattern:@"\\b\\d{6,}\\b" options:0 error:nil];
    [digitsPattern replaceMatchesInString:clean options:0 range:NSMakeRange(0, clean.length) withTemplate:@" "];
    NSString *trimmed = [clean stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@" -_|,，。:：·"]];
    trimmed = [trimmed stringByReplacingOccurrencesOfString:@"\\s+" withString:@" "
                                                    options:NSRegularExpressionSearch
                                                      range:NSMakeRange(0, trimmed.length)];
    trimmed = [trimmed stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    if (trimmed.length == 0) return nil;
    if (trimmed.length > 40) trimmed = [trimmed substringToIndex:40];
    trimmed = [trimmed stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    return trimmed;
}

- (void)updateLanguageMenus {
    BOOL chinese = [self isChineseInterface];
    self.startRecordingItem.title = chinese ? @"开始录音" : @"Start recording";
    self.stopRecordingItem.title = chinese ? @"停止录音" : @"Stop recording";    self.transcriptionModeItem.title = chinese ? @"转写模式" : @"Transcription mode";
    self.fastTranscriptionItem.title = chinese ? @"快速转写（不区分说话人）" : @"Fast transcription (no speakers)";
    self.standardTranscriptionItem.title = chinese ? @"标准转写（区分说话人）" : @"Standard transcription (speakers)";
    self.interfaceLanguageItem.title = chinese ? @"系统语言" : @"Language";
    self.recordingReminderItem.title = chinese ? @"录音提醒" : @"Recording reminders";
    self.reminderOffItem.title = chinese ? @"不提醒" : @"Off";
    self.reminderAutomaticItem.title = chinese ? @"自动提醒" : @"Automatic reminders";
    self.reminderFullItem.title = chinese ? @"全自动" : @"Automatic recording";
    self.showWindowItem.title = chinese ? @"显示窗口" : @"Show window";
    self.quitItem.title = chinese ? @"退出 Snack Record" : @"Quit Snack Record";
    self.mainQuitItem.title = chinese ? @"退出 Snack Record" : @"Quit Snack Record";
    self.englishInterfaceItem.state = chinese ? NSControlStateValueOff : NSControlStateValueOn;
    self.chineseInterfaceItem.state = chinese ? NSControlStateValueOn : NSControlStateValueOff;
    BOOL standard = [self.transcriptionMode isEqualToString:TranscriptionModeStandard];
    self.fastTranscriptionItem.state = standard ? NSControlStateValueOff : NSControlStateValueOn;
    self.standardTranscriptionItem.state = standard ? NSControlStateValueOn : NSControlStateValueOff;
    BOOL automaticReminder = [self.recordingReminderMode isEqualToString:@"automatic"];
    BOOL fullReminder = [self.recordingReminderMode isEqualToString:@"full"];
    self.reminderOffItem.state = (automaticReminder || fullReminder) ? NSControlStateValueOff : NSControlStateValueOn;
    self.reminderAutomaticItem.state = automaticReminder ? NSControlStateValueOn : NSControlStateValueOff;
    self.reminderFullItem.state = fullReminder ? NSControlStateValueOn : NSControlStateValueOff;
    [self updateMeetilyIntegrationItem];
    [self updateSettingsPanel];
}

- (void)updateMeetilyIntegrationItem {
    BOOL chinese = [self isChineseInterface];
    BOOL enabled = [NSUserDefaults.standardUserDefaults boolForKey:@"SnackRecordMeetilyIntegration"];
    BOOL installed = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:@"com.meetily.ai"] != nil;
    NSString *base = chinese ? @"Meetily 转写总结" : @"Meetily transcription";
    self.meetilyIntegrationItem.title = [NSString stringWithFormat:@"%@：%@", base, enabled ? (chinese ? @"开" : @"On") : (chinese ? @"关" : @"Off")];
    self.meetilyIntegrationItem.state = enabled ? NSControlStateValueOn : NSControlStateValueOff;
    self.meetilyIntegrationItem.enabled = installed;
    self.meetilyIntegrationItem.toolTip = installed ? nil : (chinese ? @"未安装 Meetily（com.meetily.ai）" : @"Meetily (com.meetily.ai) not installed");
}

- (void)toggleMeetilyIntegration:(id)sender {
    BOOL enabled = [NSUserDefaults.standardUserDefaults boolForKey:@"SnackRecordMeetilyIntegration"];
    [NSUserDefaults.standardUserDefaults setBool:!enabled forKey:@"SnackRecordMeetilyIntegration"];
    [self updateMeetilyIntegrationItem];
}

- (void)sendToMeetilyWithURL:(NSURL *)audioURL title:(NSString *)title {
    if (![NSUserDefaults.standardUserDefaults boolForKey:@"SnackRecordMeetilyIntegration"]) return;
    NSURL *meetilyURL = [NSWorkspace.sharedWorkspace URLForApplicationWithBundleIdentifier:@"com.meetily.ai"];
    if (!meetilyURL) return;
    NSString *safeTitle = title.length > 0 ? title : @"Snack Record Recording";
    NSURL *meetilyBinary = [meetilyURL URLByAppendingPathComponent:@"Contents/MacOS/meetily"];
    if (![NSFileManager.defaultManager isExecutableFileAtPath:meetilyBinary.path]) return;
    NSMutableArray<NSString *> *arguments = [@[@"--import", audioURL.path, @"--title", safeTitle] mutableCopy];
    NSString *meetilyModel = [NSUserDefaults.standardUserDefaults stringForKey:@"SnackRecordMeetilyModel"];
    if (meetilyModel.length > 0) {
        [arguments addObject:@"--model"];
        [arguments addObject:meetilyModel];
    }
    NSTask *openTask = [[NSTask alloc] init];
    openTask.executableURL = meetilyBinary;
    openTask.arguments = arguments;
    NSFileHandle *devNull = [NSFileHandle fileHandleWithNullDevice];
    openTask.standardOutput = devNull;
    openTask.standardError = devNull;
    NSError *error = nil;
    if (![openTask launchAndReturnError:&error]) {
        NSLog(@"Snack Record meetily integration launch error: %@", error);
        return;
    }
    NSLog(@"Snack Record sent recording to Meetily: %@ (title=%@)", audioURL.path, safeTitle);
}

- (NSTextField *)settingsLabelWithFrame:(NSRect)frame {
    NSTextField *label = [NSTextField labelWithString:@""];
    label.frame = frame;
    label.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
    label.textColor = NSColor.labelColor;
    return label;
}

- (void)configureSettingsPanel {
    self.settingsPanel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 520, 620)
                                                   styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                                                     backing:NSBackingStoreBuffered
                                                       defer:NO];
    self.settingsPanel.releasedWhenClosed = NO;
    self.settingsPanel.title = @"Settings";
    self.settingsPanel.backgroundColor = AppBackground();
    NSView *view = self.settingsPanel.contentView;

    self.settingsTitleLabel = [NSTextField labelWithString:@"Settings"];
    self.settingsTitleLabel.frame = NSMakeRect(24, 564, 472, 28);
    self.settingsTitleLabel.font = [NSFont systemFontOfSize:20 weight:NSFontWeightSemibold];
    self.settingsTitleLabel.textColor = BrandOrange();
    [view addSubview:self.settingsTitleLabel];

    self.settingsDescriptionLabel = [NSTextField labelWithString:@"Changes are saved automatically."];
    self.settingsDescriptionLabel.frame = NSMakeRect(24, 540, 472, 20);
    self.settingsDescriptionLabel.font = [NSFont systemFontOfSize:12];
    self.settingsDescriptionLabel.textColor = NSColor.secondaryLabelColor;
    [view addSubview:self.settingsDescriptionLabel];

    self.languageSettingLabel = [self settingsLabelWithFrame:NSMakeRect(24, 493, 142, 25)];
    self.transcriptionSettingLabel = [self settingsLabelWithFrame:NSMakeRect(24, 447, 142, 25)];
    self.reminderSettingLabel = [self settingsLabelWithFrame:NSMakeRect(24, 401, 142, 25)];
    [view addSubview:self.languageSettingLabel];
    [view addSubview:self.transcriptionSettingLabel];
    [view addSubview:self.reminderSettingLabel];

    self.languageSettingPopup = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(172, 488, 324, 32) pullsDown:NO];
    [self.languageSettingPopup addItemsWithTitles:@[@"中文", @"English"]];
    self.languageSettingPopup.target = self;
    self.languageSettingPopup.action = @selector(changeLanguageFromSettings:);
    [view addSubview:self.languageSettingPopup];

    self.transcriptionSettingPopup = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(172, 442, 324, 32) pullsDown:NO];
    [self.transcriptionSettingPopup addItemsWithTitles:@[@"Fast transcription", @"Standard transcription"]];
    self.transcriptionSettingPopup.target = self;
    self.transcriptionSettingPopup.action = @selector(changeTranscriptionFromSettings:);
    [view addSubview:self.transcriptionSettingPopup];

    self.reminderSettingPopup = [[NSPopUpButton alloc] initWithFrame:NSMakeRect(172, 396, 324, 32) pullsDown:NO];
    [self.reminderSettingPopup addItemsWithTitles:@[@"Off", @"Automatic reminders", @"Automatic recording"]];
    self.reminderSettingPopup.target = self;
    self.reminderSettingPopup.action = @selector(changeReminderFromSettings:);
    [view addSubview:self.reminderSettingPopup];

    NSBox *separator = [[NSBox alloc] initWithFrame:NSMakeRect(24, 371, 472, 1)];
    separator.boxType = NSBoxSeparator;
    [view addSubview:separator];

    self.meetingPromptSettingLabel = [self settingsLabelWithFrame:NSMakeRect(24, 337, 300, 25)];
    [view addSubview:self.meetingPromptSettingLabel];

    self.meetingPromptCountLabel = [NSTextField labelWithString:@""];
    self.meetingPromptCountLabel.frame = NSMakeRect(350, 337, 146, 20);
    self.meetingPromptCountLabel.alignment = NSTextAlignmentRight;
    self.meetingPromptCountLabel.font = [NSFont systemFontOfSize:11];
    self.meetingPromptCountLabel.textColor = NSColor.secondaryLabelColor;
    [view addSubview:self.meetingPromptCountLabel];

    self.meetingPromptScrollView = [[NSScrollView alloc] initWithFrame:NSMakeRect(24, 228, 472, 100)];
    self.meetingPromptScrollView.borderType = NSBezelBorder;
    self.meetingPromptScrollView.hasVerticalScroller = YES;
    self.meetingPromptScrollView.autohidesScrollers = YES;
    self.meetingPromptTextView = [[NSTextView alloc] initWithFrame:self.meetingPromptScrollView.contentView.bounds];
    self.meetingPromptTextView.delegate = self;
    self.meetingPromptTextView.font = [NSFont systemFontOfSize:13];
    self.meetingPromptTextView.textContainerInset = NSMakeSize(7, 7);
    self.meetingPromptTextView.verticallyResizable = YES;
    self.meetingPromptTextView.horizontallyResizable = NO;
    self.meetingPromptTextView.autoresizingMask = NSViewWidthSizable;
    self.meetingPromptTextView.textContainer.widthTracksTextView = YES;
    self.meetingPromptScrollView.documentView = self.meetingPromptTextView;
    [view addSubview:self.meetingPromptScrollView];

    self.outputFolderSettingLabel = [self settingsLabelWithFrame:NSMakeRect(24, 188, 472, 25)];
    [view addSubview:self.outputFolderSettingLabel];

    self.outputFolderPathField = [[NSTextField alloc] initWithFrame:NSMakeRect(24, 148, 370, 28)];
    self.outputFolderPathField.editable = NO;
    self.outputFolderPathField.selectable = YES;
    self.outputFolderPathField.lineBreakMode = NSLineBreakByTruncatingMiddle;
    self.outputFolderPathField.font = [NSFont systemFontOfSize:12];
    [view addSubview:self.outputFolderPathField];

    self.chooseOutputFolderButton = [[NSButton alloc] initWithFrame:NSMakeRect(404, 146, 92, 32)];
    self.chooseOutputFolderButton.bezelStyle = NSBezelStyleRounded;
    self.chooseOutputFolderButton.target = self;
    self.chooseOutputFolderButton.action = @selector(chooseOutputFolder:);
    [view addSubview:self.chooseOutputFolderButton];

    self.dailyFolderCheckbox = [[NSButton alloc] initWithFrame:NSMakeRect(24, 101, 472, 28)];
    self.dailyFolderCheckbox.buttonType = NSButtonTypeSwitch;
    self.dailyFolderCheckbox.target = self;
    self.dailyFolderCheckbox.action = @selector(toggleDailyFolder:);
    [view addSubview:self.dailyFolderCheckbox];

    [self updateSettingsPanel];
}

- (void)updateSettingsPanel {
    if (!self.settingsPanel) return;
    BOOL chinese = [self isChineseInterface];
    self.settingsPanel.title = chinese ? @"设置" : @"Settings";
    self.settingsTitleLabel.stringValue = chinese ? @"设置" : @"Settings";
    self.settingsDescriptionLabel.stringValue = chinese ? @"修改会自动保存，并立即生效。" : @"Changes are saved automatically and apply immediately.";
    self.languageSettingLabel.stringValue = chinese ? @"界面语言" : @"Language";
    self.transcriptionSettingLabel.stringValue = chinese ? @"转写模式" : @"Transcription mode";
    self.reminderSettingLabel.stringValue = chinese ? @"录音提醒" : @"Recording reminders";
    self.meetingPromptSettingLabel.stringValue = chinese ? @"会议纪要 Prompt（最多 600 字）" : @"Meeting notes prompt (600 characters max)";
    self.outputFolderSettingLabel.stringValue = chinese ? @"转写文件保存位置" : @"Transcript output folder";
    self.chooseOutputFolderButton.title = chinese ? @"选择…" : @"Choose…";
    self.dailyFolderCheckbox.title = chinese ? @"每天按日期新建文件夹并保存当天转写" : @"Create one dated folder per day for transcripts";
    [self.transcriptionSettingPopup itemAtIndex:0].title = chinese ? @"快速转写（不区分说话人）" : @"Fast transcription (no speakers)";
    [self.transcriptionSettingPopup itemAtIndex:1].title = chinese ? @"标准转写（区分说话人）" : @"Standard transcription (speakers)";
    [self.reminderSettingPopup itemAtIndex:0].title = chinese ? @"不提醒" : @"Off";
    [self.reminderSettingPopup itemAtIndex:1].title = chinese ? @"自动提醒" : @"Automatic reminders";
    [self.reminderSettingPopup itemAtIndex:2].title = chinese ? @"全自动" : @"Automatic recording";
    [self.languageSettingPopup selectItemAtIndex:chinese ? 0 : 1];
    [self.transcriptionSettingPopup selectItemAtIndex:[self.transcriptionMode isEqualToString:TranscriptionModeStandard] ? 1 : 0];
    [self.reminderSettingPopup selectItemAtIndex:[self.recordingReminderMode isEqualToString:@"automatic"] ? 1 : ([self.recordingReminderMode isEqualToString:@"full"] ? 2 : 0)];
    NSString *prompt = [NSUserDefaults.standardUserDefaults stringForKey:SnackRecordMeetingPromptKey] ?: SnackRecordDefaultMeetingPrompt;
    if (![self.settingsPanel.firstResponder isEqual:self.meetingPromptTextView]) self.meetingPromptTextView.string = prompt;
    self.meetingPromptCountLabel.stringValue = [NSString stringWithFormat:@"%lu / 600", (unsigned long)prompt.length];
    self.outputFolderPathField.stringValue = [NSUserDefaults.standardUserDefaults stringForKey:SnackRecordOutputDirectoryKey] ?: @"";
    self.outputFolderPathField.toolTip = self.outputFolderPathField.stringValue;
    self.dailyFolderCheckbox.state = [NSUserDefaults.standardUserDefaults boolForKey:SnackRecordDailyFolderKey]
        ? NSControlStateValueOn
        : NSControlStateValueOff;
}

- (BOOL)textView:(NSTextView *)textView
shouldChangeTextInRange:(NSRange)affectedCharRange
 replacementString:(NSString *)replacementString {
    if (textView != self.meetingPromptTextView) return YES;
    NSUInteger nextLength = textView.string.length - affectedCharRange.length + replacementString.length;
    return nextLength <= 600;
}

- (void)textDidChange:(NSNotification *)notification {
    if (notification.object != self.meetingPromptTextView) return;
    NSString *prompt = self.meetingPromptTextView.string;
    [NSUserDefaults.standardUserDefaults setObject:prompt forKey:SnackRecordMeetingPromptKey];
    self.meetingPromptCountLabel.stringValue = [NSString stringWithFormat:@"%lu / 600", (unsigned long)prompt.length];
}

- (void)chooseOutputFolder:(id)sender {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.canChooseFiles = NO;
    panel.canChooseDirectories = YES;
    panel.allowsMultipleSelection = NO;
    panel.canCreateDirectories = YES;
    NSString *currentPath = [NSUserDefaults.standardUserDefaults stringForKey:SnackRecordOutputDirectoryKey];
    if (currentPath.length > 0) panel.directoryURL = [NSURL fileURLWithPath:currentPath isDirectory:YES];
    __weak typeof(self) weakSelf = self;
    [panel beginSheetModalForWindow:self.settingsPanel completionHandler:^(NSModalResponse result) {
        if (result != NSModalResponseOK || !panel.URL) return;
        [NSUserDefaults.standardUserDefaults setObject:panel.URL.path forKey:SnackRecordOutputDirectoryKey];
        [weakSelf updateSettingsPanel];
    }];
}

- (void)toggleDailyFolder:(NSButton *)sender {
    [NSUserDefaults.standardUserDefaults setBool:sender.state == NSControlStateValueOn forKey:SnackRecordDailyFolderKey];
}

- (void)showSettings {
    [self updateSettingsPanel];
    NSRect parentFrame = self.controller.window.frame;
    NSRect settingsFrame = self.settingsPanel.frame;
    NSPoint origin = NSMakePoint(NSMidX(parentFrame) - NSWidth(settingsFrame) / 2.0,
                                 NSMidY(parentFrame) - NSHeight(settingsFrame) / 2.0);
    [self.settingsPanel setFrameOrigin:origin];
    [self.settingsPanel makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)changeLanguageFromSettings:(NSPopUpButton *)sender {
    [self changeInterfaceLanguage:sender.indexOfSelectedItem == 0 ? @"zh" : @"en"];
}

- (void)changeTranscriptionFromSettings:(NSPopUpButton *)sender {
    [self changeTranscriptionMode:sender.indexOfSelectedItem == 1 ? TranscriptionModeStandard : TranscriptionModeFast];
}

- (void)changeReminderFromSettings:(NSPopUpButton *)sender {
    NSInteger index = sender.indexOfSelectedItem;
    [self changeRecordingReminderMode:index == 1 ? @"automatic" : (index == 2 ? @"full" : @"off")];
}

- (void)changeInterfaceLanguage:(NSString *)language {
    self.interfaceLanguage = [language isEqualToString:@"zh"] ? @"zh" : @"en";
    [NSUserDefaults.standardUserDefaults setObject:self.interfaceLanguage forKey:@"SnackRecordInterfaceLanguage"];
    [self.controller applyInterfaceLanguage:self.interfaceLanguage];
    [self.meetingReminderMonitor applyInterfaceLanguage:self.interfaceLanguage];
    [self updateLanguageMenus];
}

- (void)selectEnglishInterface:(id)sender { [self changeInterfaceLanguage:@"en"]; }
- (void)selectChineseInterface:(id)sender { [self changeInterfaceLanguage:@"zh"]; }

- (void)changeTranscriptionMode:(NSString *)mode {
    self.transcriptionMode = [mode isEqualToString:TranscriptionModeStandard]
        ? TranscriptionModeStandard
        : TranscriptionModeFast;
    [NSUserDefaults.standardUserDefaults setObject:self.transcriptionMode forKey:@"SnackRecordTranscriptionMode"];
    [self.controller applyTranscriptionMode:self.transcriptionMode];
    [self updateLanguageMenus];
}

- (void)selectFastTranscription:(id)sender { [self changeTranscriptionMode:TranscriptionModeFast]; }
- (void)selectStandardTranscription:(id)sender { [self changeTranscriptionMode:TranscriptionModeStandard]; }

- (void)changeRecordingReminderMode:(NSString *)mode {
    self.recordingReminderMode = [mode isEqualToString:@"automatic"] ? @"automatic" : ([mode isEqualToString:@"full"] ? @"full" : @"off");
    [NSUserDefaults.standardUserDefaults setObject:self.recordingReminderMode forKey:@"SnackRecordReminderMode"];
    self.meetingReminderMonitor.fullAutomatic = [self.recordingReminderMode isEqualToString:@"full"];
    [self.meetingReminderMonitor setMonitoringEnabled:[self.recordingReminderMode isEqualToString:@"automatic"] || [self.recordingReminderMode isEqualToString:@"full"]];
    [self updateLanguageMenus];
}

- (void)disableRecordingReminders:(id)sender { [self changeRecordingReminderMode:@"off"]; }
- (void)enableAutomaticRecordingReminders:(id)sender { [self changeRecordingReminderMode:@"automatic"]; }
- (void)enableFullAutomaticRecording:(id)sender { [self changeRecordingReminderMode:@"full"]; }

- (void)configureStatusItem {
    self.statusItem = [NSStatusBar.systemStatusBar statusItemWithLength:NSSquareStatusItemLength];
    self.statusIcon = [self menuBarTemplateIcon];
    self.statusItem.button.image = self.statusIcon;
    self.statusItem.button.imageScaling = NSImageScaleProportionallyDown;
    self.statusItem.button.contentTintColor = nil;
    self.statusItem.button.toolTip = @"Snack Record";

    NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Snack Record"];
    self.startRecordingItem = [[NSMenuItem alloc] initWithTitle:@"Start recording" action:@selector(startRecordingFromMenu:) keyEquivalent:@""];
    self.startRecordingItem.target = self;
    [menu addItem:self.startRecordingItem];
    self.stopRecordingItem = [[NSMenuItem alloc] initWithTitle:@"Stop recording" action:@selector(stopRecordingFromMenu:) keyEquivalent:@""];
    self.stopRecordingItem.target = self;
    [menu addItem:self.stopRecordingItem];
    [menu addItem:NSMenuItem.separatorItem];

    self.transcriptionModeItem = [[NSMenuItem alloc] initWithTitle:@"Transcription mode" action:nil keyEquivalent:@""];
    NSMenu *transcriptionModeMenu = [[NSMenu alloc] initWithTitle:@"Transcription mode"];
    self.fastTranscriptionItem = [[NSMenuItem alloc] initWithTitle:@"Fast transcription (no speakers)" action:@selector(selectFastTranscription:) keyEquivalent:@""];
    self.fastTranscriptionItem.target = self;
    [transcriptionModeMenu addItem:self.fastTranscriptionItem];
    self.standardTranscriptionItem = [[NSMenuItem alloc] initWithTitle:@"Standard transcription (speakers)" action:@selector(selectStandardTranscription:) keyEquivalent:@""];
    self.standardTranscriptionItem.target = self;
    [transcriptionModeMenu addItem:self.standardTranscriptionItem];
    self.transcriptionModeItem.submenu = transcriptionModeMenu;
    [menu addItem:self.transcriptionModeItem];

    self.meetilyIntegrationItem = [[NSMenuItem alloc] initWithTitle:@"" action:@selector(toggleMeetilyIntegration:) keyEquivalent:@""];
    self.meetilyIntegrationItem.target = self;
    [menu addItem:self.meetilyIntegrationItem];

    self.recordingReminderItem = [[NSMenuItem alloc] initWithTitle:@"Recording reminders" action:nil keyEquivalent:@""];
    NSMenu *recordingReminderMenu = [[NSMenu alloc] initWithTitle:@"Recording reminders"];
    self.reminderOffItem = [[NSMenuItem alloc] initWithTitle:@"Off" action:@selector(disableRecordingReminders:) keyEquivalent:@""];
    self.reminderOffItem.target = self;
    [recordingReminderMenu addItem:self.reminderOffItem];
    self.reminderAutomaticItem = [[NSMenuItem alloc] initWithTitle:@"Automatic reminders" action:@selector(enableAutomaticRecordingReminders:) keyEquivalent:@""];
    self.reminderAutomaticItem.target = self;
    [recordingReminderMenu addItem:self.reminderAutomaticItem];
    self.reminderFullItem = [[NSMenuItem alloc] initWithTitle:@"Automatic recording" action:@selector(enableFullAutomaticRecording:) keyEquivalent:@""];
    self.reminderFullItem.target = self;
    [recordingReminderMenu addItem:self.reminderFullItem];
    self.recordingReminderItem.submenu = recordingReminderMenu;
    [menu addItem:self.recordingReminderItem];

    self.interfaceLanguageItem = [[NSMenuItem alloc] initWithTitle:@"Language" action:nil keyEquivalent:@""];
    NSMenu *interfaceMenu = [[NSMenu alloc] initWithTitle:@"Language"];
    self.englishInterfaceItem = [[NSMenuItem alloc] initWithTitle:@"English" action:@selector(selectEnglishInterface:) keyEquivalent:@""];
    self.englishInterfaceItem.target = self;
    [interfaceMenu addItem:self.englishInterfaceItem];
    self.chineseInterfaceItem = [[NSMenuItem alloc] initWithTitle:@"中文" action:@selector(selectChineseInterface:) keyEquivalent:@""];
    self.chineseInterfaceItem.target = self;
    [interfaceMenu addItem:self.chineseInterfaceItem];
    self.interfaceLanguageItem.submenu = interfaceMenu;
    [menu addItem:self.interfaceLanguageItem];

    [menu addItem:NSMenuItem.separatorItem];
    self.showWindowItem = [[NSMenuItem alloc] initWithTitle:@"Show window" action:@selector(showWindowFromMenu:) keyEquivalent:@""];
    self.showWindowItem.target = self;
    [menu addItem:self.showWindowItem];
    [menu addItem:NSMenuItem.separatorItem];
    self.quitItem = [[NSMenuItem alloc] initWithTitle:@"Quit Snack Record" action:@selector(quitFromMenu:) keyEquivalent:@"q"];
    self.quitItem.target = self;
    [menu addItem:self.quitItem];
    self.statusItem.menu = menu;
    [self updateLanguageMenus];
}

- (void)configureMainMenu {
    NSMenu *mainMenu = [[NSMenu alloc] initWithTitle:@""];
    NSMenuItem *applicationMenuItem = [[NSMenuItem alloc] initWithTitle:@"Snack Record" action:nil keyEquivalent:@""];
    [mainMenu addItem:applicationMenuItem];

    NSMenu *applicationMenu = [[NSMenu alloc] initWithTitle:@"Snack Record"];
    self.mainQuitItem = [[NSMenuItem alloc] initWithTitle:@"退出 Snack Record" action:@selector(quitFromMenu:) keyEquivalent:@"q"];
    self.mainQuitItem.keyEquivalentModifierMask = NSEventModifierFlagCommand;
    self.mainQuitItem.target = self;
    [applicationMenu addItem:self.mainQuitItem];
    applicationMenuItem.submenu = applicationMenu;
    NSApp.mainMenu = mainMenu;
    [self updateLanguageMenus];
}

- (void)startRecordingFromMenu:(id)sender { [self.controller startRecordingIfNeeded]; }
- (void)stopRecordingFromMenu:(id)sender { [self.controller stopRecordingIfNeeded]; }
- (void)showWindowFromMenu:(id)sender { [self.controller showWindow]; }
- (void)quitFromMenu:(id)sender { [NSApp terminate:nil]; }

- (void)updateStatusItemForState:(TranscriptionState)state {
    self.startRecordingItem.enabled = state != TranscriptionStateRecording;
    self.stopRecordingItem.enabled = state == TranscriptionStateRecording;
}

- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    if (self.terminationCleanupInProgress) return NSTerminateLater;
    if ([self.controller hasActiveWork]) {
        BOOL chinese = [self isChineseInterface];
        NSAlert *alert = [[NSAlert alloc] init];
        alert.alertStyle = NSAlertStyleWarning;
        alert.messageText = chinese ? @"录制或转写仍在进行" : @"Recording or transcription is still in progress";
        alert.informativeText = chinese ? @"现在退出会中断尚未完成的录制或转写，相关音频和文本可能不会保存。" : @"Quitting now will interrupt unfinished recording or transcription work, and related audio or transcripts may not be saved.";
        [alert addButtonWithTitle:chinese ? @"继续处理" : @"Keep processing"];
        [alert addButtonWithTitle:chinese ? @"退出" : @"Quit"];
        if ([alert runModal] != NSAlertSecondButtonReturn) return NSTerminateCancel;
    }
    [self beginTerminationCleanup];
    return NSTerminateLater;
}

- (void)beginTerminationCleanup {
    if (self.terminationCleanupInProgress) return;
    self.terminationCleanupInProgress = YES;
    dispatch_group_t cleanupGroup = dispatch_group_create();
    dispatch_group_enter(cleanupGroup);
    [self.meetingReminderMonitor stopWithCompletion:^{ dispatch_group_leave(cleanupGroup); }];
    dispatch_group_enter(cleanupGroup);
    [self.controller shutdownForApplicationTerminationWithCompletion:^{ dispatch_group_leave(cleanupGroup); }];
    dispatch_group_notify(cleanupGroup, dispatch_get_main_queue(), ^{
        [NSApp replyToApplicationShouldTerminate:YES];
    });
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return NO; }
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag { [self.controller showWindow]; return NO; }
- (void)applicationDidBecomeActive:(NSNotification *)notification {
    [self.controller refreshMicrophoneAuthorization];
    [self.controller refreshIntegrationAvailability];
}
- (void)applicationWillTerminate:(NSNotification *)notification {
    if (self.shortcutMonitor) [NSEvent removeMonitor:self.shortcutMonitor];
    if (self.recordingHotKey) UnregisterEventHotKey(self.recordingHotKey);
    if (self.hotKeyEventHandler) RemoveEventHandler(self.hotKeyEventHandler);
    [self.meetingReminderMonitor stop];
    [self.controller shutdownForApplicationTerminationWithCompletion:nil];
}

@end


int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *application = [NSApplication sharedApplication];
        NSImage *applicationIcon = RoundedApplicationIcon();
        if (applicationIcon) application.applicationIconImage = applicationIcon;
        AppDelegate *delegate = [[AppDelegate alloc] init];
        application.delegate = delegate;
        [application run];
    }
    return 0;
}
