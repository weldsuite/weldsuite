"use client";

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { Input } from '@weldsuite/ui/components/input';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { Package, MapPin, Clock, Phone, MessageSquare, Search, Plus, X, Navigation, ChevronDown } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';

// Dynamic import for Mapbox to avoid SSR issues
const TrackingMap = dynamic(() => import('../components/tracking-map'), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full bg-gradient-to-br from-green-50 via-blue-50 to-gray-100 flex items-center justify-center">
      <div className="text-gray-500">Loading map...</div>
    </div>
  )
});

export default function HomePage() {
  const [selectedShipment, setSelectedShipment] = useState('SP9876543210');
  const [showLiveTracking, setShowLiveTracking] = useState(true);
  const [isExpanded, setIsExpanded] = useState(true);

  const shipments = [
    { id: 'SP4981241965', status: 'Shipped', color: 'bg-green-500' },
    { id: 'SP9876543210', status: 'In Transit', color: 'bg-blue-500' },
    { id: 'SP1683513014', status: 'Pending', color: 'bg-yellow-500' }
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b">
        <div className="flex h-16 items-center px-6">
          <h1 className="text-lg font-semibold">Shipment Tracking</h1>
        </div>
      </div>

      <div className="flex h-[calc(100vh-64px)]">
        {/* Left Sidebar - Shipment List */}
        <div className="w-96 bg-background border-r overflow-y-auto">
          <div className="p-[18px]">
            {/* Search Bar */}
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search Shipping ID"
                className="pl-10 shadow-none"
              />
            </div>

            {/* Shipment Cards */}
            <div className="space-y-3">
              {shipments.map((shipment) => (
                <Card
                  key={shipment.id}
                  className={`p-4 cursor-pointer transition-colors shadow-none rounded-md ${
                    selectedShipment === shipment.id
                      ? 'bg-accent'
                      : 'hover:bg-accent/50'
                  }`}
                  onClick={() => setSelectedShipment(shipment.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="space-y-1.5">
                      <p className="text-sm font-medium leading-none">Shipping #{shipment.id}</p>
                      <p className="text-sm text-muted-foreground">
                        {shipment.status === 'In Transit' ? 'Expected today' : 'November 23, 2023'}
                      </p>
                    </div>
                    <Badge 
                      variant={shipment.status === 'Shipped' ? 'default' : shipment.status === 'In Transit' ? 'secondary' : 'outline'}
                    >
                      {shipment.status}
                    </Badge>
                  </div>

                  {selectedShipment === shipment.id && (
                    <>
                      <div className="border-t mt-2 mb-3" />
                      {/* Timeline */}
                      <div className="space-y-3">
                        <div className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <div className="w-2 h-2 bg-muted-foreground/50 rounded-full"></div>
                            <div className="w-px h-10 bg-border"></div>
                          </div>
                          <div className="flex-1 space-y-1">
                            <p className="text-sm font-medium leading-none">Package picked up</p>
                            <p className="text-sm text-muted-foreground">Nuremberg • 09:13 AM</p>
                          </div>
                        </div>

                        <div className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <div className="w-2 h-2 bg-muted-foreground/50 rounded-full"></div>
                            <div className="w-px h-10 bg-border"></div>
                          </div>
                          <div className="flex-1 space-y-1">
                            <p className="text-sm font-medium leading-none">In transit</p>
                            <p className="text-sm text-muted-foreground">Würzburg • 10:17 AM</p>
                          </div>
                        </div>

                        <div className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <div className="w-2 h-2 bg-muted-foreground/50 rounded-full"></div>
                            <div className="w-px h-10 bg-border"></div>
                          </div>
                          <div className="flex-1 space-y-1">
                            <p className="text-sm font-medium leading-none">In transit</p>
                            <p className="text-sm text-muted-foreground">Aschaffenburg • 10:42 AM</p>
                          </div>
                        </div>

                        <div className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <div className="w-2 h-2 bg-primary rounded-full ring-2 ring-primary/20"></div>
                            <div className="w-px h-10 bg-transparent"></div>
                          </div>
                          <div className="flex-1 space-y-1">
                            <p className="text-sm font-medium leading-none">En route to destination</p>
                            <p className="text-sm text-muted-foreground">Frankfurt • 11:20 AM</p>
                          </div>
                        </div>
                      </div>
                    </>
                  )}
                </Card>
              ))}
            </div>
          </div>
        </div>

        {/* Main Content - Map */}
        <div className="flex-1 relative">
          {/* Mapbox Map */}
          <div className="absolute inset-0">
            <TrackingMap selectedShipment={selectedShipment} />
            
            {/* Distance Info Overlay */}
            <Card className="absolute top-4 left-4 p-3 shadow-none border rounded-md">
              <div className="flex gap-6">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Total Distance</p>
                  <p className="text-xl font-semibold">225 km</p>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Est. Delivery Time</p>
                  <p className="text-xl font-semibold">2h 40m</p>
                </div>
              </div>
            </Card>
          </div>

          {/* Bottom Status Card */}
          {showLiveTracking && (
            <Card className="absolute bottom-4 left-1/2 transform -translate-x-1/2 w-[720px] p-4 shadow-none border rounded-md">
              {isExpanded ? (
                <>
                  <div className="flex items-start justify-between -mb-1">
                    <h3 className="text-lg font-semibold flex items-center gap-2">
                      <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                      Live Shipment Tracking
                    </h3>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setIsExpanded(!isExpanded)}
                      className="h-8 w-8"
                    >
                      <ChevronDown className="h-4 w-4 transition-transform" />
                    </Button>
                  </div>

                  <div className="grid grid-cols-2 gap-1 -mb-1">
                <div className="space-y-0.5">
                  <p className="text-sm text-muted-foreground">Shipping ID</p>
                  <p className="text-sm font-medium">#{selectedShipment}</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-sm text-muted-foreground">Status</p>
                  <Badge variant="secondary">In Transit</Badge>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1 -mb-1">
                <div className="space-y-0.5">
                  <p className="text-sm text-muted-foreground">From</p>
                  <p className="text-sm font-medium">Aschaffenburg</p>
                </div>
                <div className="space-y-0.5">
                  <p className="text-sm text-muted-foreground">To</p>
                  <p className="text-sm font-medium">Frankfurt</p>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="space-y-2 -mb-1">
                <div className="flex justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 bg-primary rounded-full"></div>
                    <span className="text-sm text-muted-foreground">Shipped</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Est. Arrival</span>
                    <div className="w-2 h-2 bg-muted rounded-full"></div>
                  </div>
                </div>

                <div className="relative">
                  <div className="h-2 bg-secondary rounded-full overflow-hidden">
                    <div className="h-full bg-primary rounded-full transition-all" style={{ width: '65%' }}></div>
                  </div>
                </div>

                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>Nov 23, 11:20 AM</span>
                  <span>Nov 23, 11:58 AM</span>
                </div>
              </div>

                  <div className="border-t mt-1 pt-4">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5">
                        <p className="text-sm text-muted-foreground">Total Weight</p>
                        <p className="text-sm font-medium">14.5 kg</p>
                      </div>
                      <div className="space-y-0.5 text-right">
                        <p className="text-sm text-muted-foreground">Distance Remaining</p>
                        <p className="text-sm font-medium">82 km</p>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="space-y-px">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 bg-primary rounded-full"></div>
                      <span className="text-sm text-muted-foreground">Shipped</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setIsExpanded(!isExpanded)}
                      className="h-8 w-8"
                    >
                      <ChevronDown className="h-4 w-4 transition-transform rotate-180" />
                    </Button>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Est. Arrival</span>
                      <div className="w-2 h-2 bg-muted rounded-full"></div>
                    </div>
                  </div>

                  <div className="relative">
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div className="h-full bg-primary rounded-full transition-all" style={{ width: '65%' }}></div>
                    </div>
                  </div>

                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Nov 23, 11:20 AM</span>
                    <span>Nov 23, 11:58 AM</span>
                  </div>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}