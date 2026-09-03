export enum ErrorId {
  CAMERA_NOT_CONNECTED = 'Camera not connected.',
  CAMERA_ACCESS_DENIED = 'Camera access denied.',
  CONFERENCE_NOT_FOUND = 'Conference not found.',
  CONFERENCE_AUTHENTICATION_FAILED = 'Conference authentication failed.',
  INFINITY_SERVER_UNAVAILABLE = 'Infinity server unavailable.',
  NO_BILLING_PERMISSION = 'No billing permission.',
  VIDEO_UNAVAILABLE = 'Video is unavailable for this call — audio continues on the phone line. Use Retry to attempt video again.',
  NOT_LAUNCHED_FROM_GENESYS = 'This app must be opened from a Genesys interaction. Close this tab and open the video widget from the interaction.',
  GENESYS_SIGN_IN_FAILED = 'Genesys sign-in failed. Check that the OAuth client redirect URI matches this page address, then reopen the interaction.',
  GENESYS_CONNECTION_FAILED = 'Could not connect to Genesys call state. Try again, or close and reopen the interaction.',
  MISSING_CONFIG = 'The widget is missing Pexip configuration (node, PIN or prefix). Check the interaction widget URL in Genesys.'
}
