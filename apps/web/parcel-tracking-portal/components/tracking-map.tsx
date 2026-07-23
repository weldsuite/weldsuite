"use client";

import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { Plus, Minus, Compass } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';

// You'll need to add your Mapbox token here
mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || 'pk.eyJ1IjoibWFwYm94IiwiYSI6ImNpejY4NXVycTA2emYycXBndHRqcmZ3N3gifQ.rJcFIG214AriISLbB6B5aw';

interface TrackingMapProps {
  selectedShipment: string;
}

export default function TrackingMap({ selectedShipment }: TrackingMapProps) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const [lng, setLng] = useState(8.6821);
  const [lat, setLat] = useState(50.1109);
  const [zoom, setZoom] = useState(6);

  // Load Mapbox CSS
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://api.mapbox.com/mapbox-gl-js/v3.1.0/mapbox-gl.css';
    document.head.appendChild(link);
    
    return () => {
      document.head.removeChild(link);
    };
  }, []);

  useEffect(() => {
    if (map.current) return; // initialize map only once
    if (!mapContainer.current) return;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: 'mapbox://styles/mapbox/light-v11',
      center: [lng, lat],
      zoom: zoom,
      attributionControl: false // Remove attribution control
    });

    // Don't add default navigation controls - we'll add custom ones

    // Add markers for the route
    // Nuremberg - Start point
    new mapboxgl.Marker({ color: '#ef4444' })
      .setLngLat([11.0797, 49.4521])
      .setPopup(new mapboxgl.Popup().setHTML('<div class="text-sm font-medium">Nuremberg</div><div class="text-xs text-gray-600">Package picked up</div>'))
      .addTo(map.current);

    // Würzburg - Transit point
    new mapboxgl.Marker({ color: '#3b82f6' })
      .setLngLat([9.9534, 49.7913])
      .setPopup(new mapboxgl.Popup().setHTML('<div class="text-sm font-medium">Würzburg</div><div class="text-xs text-gray-600">In transit</div>'))
      .addTo(map.current);

    // Aschaffenburg - Transit point
    new mapboxgl.Marker({ color: '#3b82f6' })
      .setLngLat([9.1430, 49.9774])
      .setPopup(new mapboxgl.Popup().setHTML('<div class="text-sm font-medium">Aschaffenburg</div><div class="text-xs text-gray-600">In transit</div>'))
      .addTo(map.current);

    // Frankfurt - Current location (animated)
    const currentLocationMarker = new mapboxgl.Marker({ color: '#14b8a6' })
      .setLngLat([8.6821, 50.1109])
      .setPopup(new mapboxgl.Popup().setHTML('<div class="text-sm font-medium">Frankfurt</div><div class="text-xs text-gray-600">Current location</div>'))
      .addTo(map.current);

    // Add route line
    map.current.on('load', () => {
      if (!map.current) return;
      
      map.current.addSource('route', {
        'type': 'geojson',
        'data': {
          'type': 'Feature',
          'properties': {},
          'geometry': {
            'type': 'LineString',
            'coordinates': [
              [11.0797, 49.4521], // Nuremberg
              [9.9534, 49.7913],  // Würzburg
              [9.1430, 49.9774],  // Aschaffenburg
              [8.6821, 50.1109]   // Frankfurt
            ]
          }
        }
      });

      map.current.addLayer({
        'id': 'route',
        'type': 'line',
        'source': 'route',
        'layout': {
          'line-join': 'round',
          'line-cap': 'round'
        },
        'paint': {
          'line-color': '#14b8a6',
          'line-width': 3,
          'line-dasharray': [2, 2]
        }
      });

      // Fit map to show all markers
      const bounds = new mapboxgl.LngLatBounds();
      bounds.extend([11.0797, 49.4521]); // Nuremberg
      bounds.extend([9.9534, 49.7913]);  // Würzburg
      bounds.extend([9.1430, 49.9774]);  // Aschaffenburg
      bounds.extend([8.6821, 50.1109]);  // Frankfurt
      
      map.current.fitBounds(bounds, {
        padding: { top: 50, bottom: 150, left: 50, right: 50 }
      });
    });

    // Update map center when it moves
    map.current.on('move', () => {
      if (!map.current) return;
      setLng(Number(map.current.getCenter().lng.toFixed(4)));
      setLat(Number(map.current.getCenter().lat.toFixed(4)));
      setZoom(Number(map.current.getZoom().toFixed(2)));
    });

    // Add pulsing effect to current location
    const pulseMarker = () => {
      currentLocationMarker.getElement()?.classList.add('pulse-marker');
    };
    pulseMarker();

  }, [lng, lat, zoom]);

  // Update map when shipment changes
  useEffect(() => {
    if (!map.current) return;

    // Here you could update markers based on the selected shipment
    // For now, we'll just re-center the map
    if (selectedShipment === 'SP9876543210') {
      map.current.flyTo({
        center: [8.6821, 50.1109], // Frankfurt
        zoom: 10
      });
    }
  }, [selectedShipment]);

  const handleZoomIn = () => {
    if (map.current) {
      map.current.zoomIn();
    }
  };

  const handleZoomOut = () => {
    if (map.current) {
      map.current.zoomOut();
    }
  };

  const handleResetNorth = () => {
    if (map.current) {
      map.current.resetNorth();
    }
  };

  return (
    <>
      <style jsx global>{`
        .pulse-marker {
          animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        @keyframes pulse {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.5;
          }
        }
        .mapboxgl-popup-content {
          padding: 10px;
          border-radius: 8px;
        }
        .mapboxgl-popup-close-button {
          display: none;
        }
      `}</style>
      <div className="relative h-full w-full">
        <div ref={mapContainer} className="h-full w-full" />

        {/* Custom Navigation Controls */}
        <div className="absolute top-4 right-4 border rounded-md bg-background overflow-hidden flex flex-col">
          <Button
            variant="ghost"
            size="icon"
            onClick={handleZoomIn}
            className="h-10 w-10 rounded-none border-b"
          >
            <Plus className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleZoomOut}
            className="h-10 w-10 rounded-none border-b"
          >
            <Minus className="h-5 w-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleResetNorth}
            className="h-10 w-10 rounded-none"
          >
            <Compass className="h-5 w-5" />
          </Button>
        </div>
      </div>
    </>
  );
}