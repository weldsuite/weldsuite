import { useEffect, useRef } from 'react';
import { ImagePlus, Ban, Loader2, X, User, VideoOff } from 'lucide-react';
import { cn } from '@weldsuite/ui/lib/utils';
import type { VirtualBackgroundType } from '../hooks/use-virtual-background';

const PROFESSIONAL_BACKGROUNDS = [
  { label: 'Modern Office', url: 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1920&q=80' },
  { label: 'Bookshelf', url: 'https://images.unsplash.com/photo-1507842217343-583bb7270b66?w=1920&q=80' },
  { label: 'Workspace', url: 'https://images.unsplash.com/photo-1524758631624-e2822e304c36?w=1920&q=80' },
  { label: 'Minimalist', url: 'https://images.unsplash.com/photo-1618221195710-dd6b41faaea6?w=1920&q=80' },
  { label: 'Conference', url: 'https://images.unsplash.com/photo-1497366811353-6870744d04b2?w=1920&q=80' },
  { label: 'Library', url: 'https://images.unsplash.com/photo-1521587760476-6c12a4b040da?w=1920&q=80' },
  { label: 'Loft', url: 'https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=1920&q=80' },
  { label: 'Meeting Room', url: 'https://images.unsplash.com/photo-1497215842964-222b430dc094?w=1920&q=80' },
  { label: 'Co-working', url: 'https://images.unsplash.com/photo-1497215728101-856f4ea42174?w=1920&q=80' },
  { label: 'Glass Office', url: 'https://images.unsplash.com/photo-1497366754035-f200968a6e72?w=1920&q=80' },
  { label: 'Startup', url: 'https://images.unsplash.com/photo-1497366412874-3415097a27e7?w=1920&q=80' },
  { label: 'Corner Office', url: 'https://images.unsplash.com/photo-1604328698692-f76ea9498e76?w=1920&q=80' },
  { label: 'Whiteboard', url: 'https://images.unsplash.com/photo-1572025442646-866d16c84a54?w=1920&q=80' },
  { label: 'Lounge', url: 'https://images.unsplash.com/photo-1540932239986-30128078f3c5?w=1920&q=80' },
  { label: 'Brick Wall', url: 'https://images.unsplash.com/photo-1464938050520-ef2571e0d6e0?w=1920&q=80' },
  { label: 'Penthouse', url: 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?w=1920&q=80' },
];

const NATURE_BACKGROUNDS = [
  { label: 'Mountains', url: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1920&q=80' },
  { label: 'Beach', url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1920&q=80' },
  { label: 'Forest', url: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1920&q=80' },
  { label: 'Lake', url: 'https://images.unsplash.com/photo-1439066615861-d1af74d74000?w=1920&q=80' },
  { label: 'Sunset', url: 'https://images.unsplash.com/photo-1495616811223-4d98c6e9c869?w=1920&q=80' },
  { label: 'Aurora', url: 'https://images.unsplash.com/photo-1483347756197-71ef80e95f73?w=1920&q=80' },
  { label: 'Waterfall', url: 'https://images.unsplash.com/photo-1432405972618-c6b0cfba5428?w=1920&q=80' },
  { label: 'Desert', url: 'https://images.unsplash.com/photo-1509316975850-ff9c5deb0cd9?w=1920&q=80' },
  { label: 'Ocean', url: 'https://images.unsplash.com/photo-1505118380757-91f5f5632de0?w=1920&q=80' },
  { label: 'Cherry Blossom', url: 'https://images.unsplash.com/photo-1522383225653-ed111181a951?w=1920&q=80' },
  { label: 'Rainforest', url: 'https://images.unsplash.com/photo-1448375240586-882707db888b?w=1920&q=80' },
  { label: 'Lavender', url: 'https://images.unsplash.com/photo-1499002238440-d264edd596ec?w=1920&q=80' },
  { label: 'Snowy Peaks', url: 'https://images.unsplash.com/photo-1491002052546-bf38f186af56?w=1920&q=80' },
  { label: 'Autumn', url: 'https://images.unsplash.com/photo-1508193638397-1c4234db14d8?w=1920&q=80' },
  { label: 'Starry Sky', url: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1920&q=80' },
  { label: 'Tropical', url: 'https://images.unsplash.com/photo-1559128010-7c1ad6e1b6a5?w=1920&q=80' },
];

const COZY_BACKGROUNDS = [
  { label: 'Living Room', url: 'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?w=1920&q=80' },
  { label: 'Fireplace', url: 'https://images.unsplash.com/photo-1600607687939-ce8a6c25118c?w=1920&q=80' },
  { label: 'Coffee Shop', url: 'https://images.unsplash.com/photo-1559305616-3f99cd43e353?w=1920&q=80' },
  { label: 'Kitchen', url: 'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=1920&q=80' },
  { label: 'Reading Nook', url: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=1920&q=80' },
  { label: 'Cabin', url: 'https://images.unsplash.com/photo-1510798831971-661eb04b3739?w=1920&q=80' },
  { label: 'Sunroom', url: 'https://images.unsplash.com/photo-1600566753190-17f0baa2a6c3?w=1920&q=80' },
  { label: 'Balcony', url: 'https://images.unsplash.com/photo-1600596542815-ffad4c1539a9?w=1920&q=80' },
  { label: 'Bedroom', url: 'https://images.unsplash.com/photo-1540518614846-7eded433c457?w=1920&q=80' },
  { label: 'Bookshelf Wall', url: 'https://images.unsplash.com/photo-1526243741027-444d633d7365?w=1920&q=80' },
  { label: 'Garden Patio', url: 'https://images.unsplash.com/photo-1600585154526-990dced4db0d?w=1920&q=80' },
  { label: 'Candle Room', url: 'https://images.unsplash.com/photo-1602028915047-37269d1a73f7?w=1920&q=80' },
  { label: 'Dining Room', url: 'https://images.unsplash.com/photo-1617806118233-18e1de247200?w=1920&q=80' },
  { label: 'Plant Corner', url: 'https://images.unsplash.com/photo-1545241047-6083a3684587?w=1920&q=80' },
  { label: 'Rustic', url: 'https://images.unsplash.com/photo-1600210492493-0946911123ea?w=1920&q=80' },
  { label: 'Window Seat', url: 'https://images.unsplash.com/photo-1513694203232-719a280e022f?w=1920&q=80' },
];

const CITY_BACKGROUNDS = [
  { label: 'New York', url: 'https://images.unsplash.com/photo-1496442226666-8d4d0e62e6e9?w=1920&q=80' },
  { label: 'Tokyo', url: 'https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?w=1920&q=80' },
  { label: 'London', url: 'https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?w=1920&q=80' },
  { label: 'Paris', url: 'https://images.unsplash.com/photo-1502602898657-3e91760cbb34?w=1920&q=80' },
  { label: 'Dubai', url: 'https://images.unsplash.com/photo-1512453979798-5ea266f8880c?w=1920&q=80' },
  { label: 'San Francisco', url: 'https://images.unsplash.com/photo-1501594907352-04cda38ebc29?w=1920&q=80' },
  { label: 'Singapore', url: 'https://images.unsplash.com/photo-1525625293386-3f8f99389edd?w=1920&q=80' },
  { label: 'Amsterdam', url: 'https://images.unsplash.com/photo-1534351590666-13e3e96b5017?w=1920&q=80' },
  { label: 'Hong Kong', url: 'https://images.unsplash.com/photo-1536599018102-9f803c140fc1?w=1920&q=80' },
  { label: 'Sydney', url: 'https://images.unsplash.com/photo-1506973035872-a4ec16b8e8d9?w=1920&q=80' },
  { label: 'Barcelona', url: 'https://images.unsplash.com/photo-1583422409516-2895a77efded?w=1920&q=80' },
  { label: 'Chicago', url: 'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?w=1920&q=80' },
];

const ABSTRACT_BACKGROUNDS = [
  { label: 'Gradient', url: 'https://images.unsplash.com/photo-1557683316-973673baf926?w=1920&q=80' },
  { label: 'Neon', url: 'https://images.unsplash.com/photo-1550684376-efcbd6e3f031?w=1920&q=80' },
  { label: 'Pastel', url: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?w=1920&q=80' },
  { label: 'Geometric', url: 'https://images.unsplash.com/photo-1558591710-4b4a1ae0f04d?w=1920&q=80' },
  { label: 'Marble', url: 'https://images.unsplash.com/photo-1541123603104-512919d6a96c?w=1920&q=80' },
  { label: 'Waves', url: 'https://images.unsplash.com/photo-1604076913837-52ab5f7c1ac4?w=1920&q=80' },
  { label: 'Bokeh', url: 'https://images.unsplash.com/photo-1517483000871-1dbf64a6e1c6?w=1920&q=80' },
  { label: 'Smoke', url: 'https://images.unsplash.com/photo-1504333638930-c8787321eee0?w=1920&q=80' },
  { label: 'Watercolor', url: 'https://images.unsplash.com/photo-1553949345-eb786bb3f7ba?w=1920&q=80' },
  { label: 'Dark Texture', url: 'https://images.unsplash.com/photo-1557682250-33bd709cbe85?w=1920&q=80' },
  { label: 'Holographic', url: 'https://images.unsplash.com/photo-1550684848-fac1c5b4e853?w=1920&q=80' },
  { label: 'Minimal Lines', url: 'https://images.unsplash.com/photo-1553356084-58ef4a67b2a7?w=1920&q=80' },
];

export interface BackgroundEffectsPanelProps {
  backgroundType: VirtualBackgroundType;
  backgroundValue: string | null;
  isLoading?: boolean;
  isOpen: boolean;
  localParticipant?: any;
  onApplyBlur: (intensity?: number) => void | Promise<void>;
  onApplyImage: (url: string) => void | Promise<void>;
  onRemove: () => void;
  onClose: () => void;
}

function VideoPreview({ participant }: { participant: any }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && participant?.videoEnabled && participant?.videoTrack) {
      videoRef.current.srcObject = new MediaStream([participant.videoTrack]);
    } else if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [participant?.videoEnabled, participant?.videoTrack]);

  return (
    <div className="aspect-video bg-black rounded-lg overflow-hidden">
      {participant?.videoEnabled && participant?.videoTrack ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover -scale-x-100"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <VideoOff className="h-8 w-8 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

function BackgroundGrid({ images, backgroundType, backgroundValue, isLoading, onApplyImage }: {
  images: { label: string; url: string }[];
  backgroundType: VirtualBackgroundType;
  backgroundValue: string | null;
  isLoading: boolean;
  onApplyImage: (url: string) => void | Promise<void>;
}) {
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {images.map((bg) => (
        <button
          key={bg.label}
          onClick={() => onApplyImage(bg.url)}
          disabled={isLoading}
          className={cn(
            'relative aspect-square rounded-lg overflow-hidden border-2 transition-colors',
            backgroundType === 'image' && backgroundValue === bg.url
              ? 'border-primary ring-1 ring-primary'
              : 'border-transparent hover:border-primary/50',
          )}
        >
          <img
            src={bg.url}
            alt={bg.label}
            className="w-full h-full object-cover"
            loading="lazy"
          />
        </button>
      ))}
    </div>
  );
}

export function BackgroundEffectsPanel({
  backgroundType,
  backgroundValue,
  isLoading = false,
  isOpen,
  localParticipant,
  onApplyBlur,
  onApplyImage,
  onRemove,
  onClose,
}: BackgroundEffectsPanelProps) {
  return (
    <div
      className="flex-shrink-0 border-l flex flex-col min-h-0 overflow-hidden"
      style={{
        width: isOpen ? 380 : 0,
        opacity: isOpen ? 1 : 0,
        transition: 'width 300ms cubic-bezier(0.25, 0.1, 0.25, 1), opacity 200ms ease',
        willChange: 'width, opacity',
      }}
    >
      <div className="w-[380px] flex flex-col min-h-0 h-full">
        {/* Header */}
        <div className="px-4 border-b flex-shrink-0 h-[53px] flex items-center justify-between">
          <span className="text-sm font-semibold">Backgrounds and effects</span>
          <div className="flex items-center gap-2">
            {isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            <button onClick={onClose} className="p-1 rounded-md hover:bg-muted transition-colors">
              <X className="h-4 w-4 text-muted-foreground" />
            </button>
          </div>
        </div>

        {/* Video preview */}
        {localParticipant && (
          <div className="p-4 border-b flex-shrink-0">
            <VideoPreview participant={localParticipant} />
          </div>
        )}

        {/* Content */}
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          {/* Blur and personal */}
          <div className="p-4 border-b">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Blur and personal</span>
            <div className="flex gap-2 mt-3">
              <button
                onClick={onRemove}
                className={cn(
                  'flex flex-col items-center justify-center gap-1.5 w-[72px] h-[72px] rounded-xl transition-colors',
                  backgroundType === 'none'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80 text-muted-foreground',
                )}
              >
                <Ban className="h-5 w-5" />
                <span className="text-[10px] font-medium">None</span>
              </button>
              <button
                onClick={() => onApplyBlur(8)}
                disabled={isLoading}
                className={cn(
                  'flex flex-col items-center justify-center gap-1.5 w-[72px] h-[72px] rounded-xl transition-colors',
                  backgroundType === 'blur' && backgroundValue === '8'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80 text-muted-foreground',
                )}
              >
                <User className="h-5 w-5 opacity-60" />
                <span className="text-[10px] font-medium">Light</span>
              </button>
              <button
                onClick={() => onApplyBlur(20)}
                disabled={isLoading}
                className={cn(
                  'flex flex-col items-center justify-center gap-1.5 w-[72px] h-[72px] rounded-xl transition-colors',
                  backgroundType === 'blur' && backgroundValue === '20'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted hover:bg-muted/80 text-muted-foreground',
                )}
              >
                <User className="h-5 w-5 opacity-30" />
                <span className="text-[10px] font-medium">Strong</span>
              </button>
              <label
                className={cn(
                  'flex flex-col items-center justify-center gap-1.5 w-[72px] h-[72px] rounded-xl cursor-pointer transition-colors',
                  'bg-muted hover:bg-muted/80 text-muted-foreground',
                )}
              >
                <ImagePlus className="h-5 w-5" />
                <span className="text-[10px] font-medium">Upload</span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const url = URL.createObjectURL(file);
                      onApplyImage(url);
                    }
                    e.target.value = '';
                  }}
                />
              </label>
            </div>
          </div>

          {/* Professional */}
          <div className="p-4 border-b">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Professional</span>
            <div className="mt-3">
              <BackgroundGrid images={PROFESSIONAL_BACKGROUNDS} backgroundType={backgroundType} backgroundValue={backgroundValue} isLoading={isLoading} onApplyImage={onApplyImage} />
            </div>
          </div>

          {/* Nature */}
          <div className="p-4 border-b">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Nature</span>
            <div className="mt-3">
              <BackgroundGrid images={NATURE_BACKGROUNDS} backgroundType={backgroundType} backgroundValue={backgroundValue} isLoading={isLoading} onApplyImage={onApplyImage} />
            </div>
          </div>

          {/* Cozy home */}
          <div className="p-4 border-b">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Cozy home</span>
            <div className="mt-3">
              <BackgroundGrid images={COZY_BACKGROUNDS} backgroundType={backgroundType} backgroundValue={backgroundValue} isLoading={isLoading} onApplyImage={onApplyImage} />
            </div>
          </div>

          {/* City */}
          <div className="p-4 border-b">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">City</span>
            <div className="mt-3">
              <BackgroundGrid images={CITY_BACKGROUNDS} backgroundType={backgroundType} backgroundValue={backgroundValue} isLoading={isLoading} onApplyImage={onApplyImage} />
            </div>
          </div>

          {/* Abstract */}
          <div className="p-4">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Abstract</span>
            <div className="mt-3">
              <BackgroundGrid images={ABSTRACT_BACKGROUNDS} backgroundType={backgroundType} backgroundValue={backgroundValue} isLoading={isLoading} onApplyImage={onApplyImage} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
