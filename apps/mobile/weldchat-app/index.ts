// The call push task must be defined before anything else: on a closed app,
// Android runs the bundle headless (no UI) just for it. See lib/call-push-task.ts.
import './lib/call-push-task';
import 'expo-router/entry';
