import { ParticipantTile as SharedParticipantTile, useIsSpeaking, type ParticipantTileProps as SharedParticipantTileProps } from '@weldsuite/weldmeet-ui/components/participant-tile';

;
type ParticipantTileProps = Omit<SharedParticipantTileProps, 'onSendMessage'>;

function ParticipantTile(props: ParticipantTileProps) {
  return (
    <SharedParticipantTile
      {...props}
      onSendMessage={(participant) => {
        const userId = participant.customParticipantId || participant.userId;
        if (userId) window.location.href = `/weldchat/dm/${userId}`;
      }}
    />
  );
}
