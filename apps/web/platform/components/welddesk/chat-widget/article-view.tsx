
import React, { useState, useEffect } from 'react';
import {
  ArrowLeft,
  X,
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';

interface ArticleViewProps {
  article: {
    id: string;
    title: string;
    content: string;
    author?: string;
    updatedAt?: string;
  };
  onBack: () => void;
  onClose: () => void;
}

export function ArticleView({ article, onBack, onClose }: ArticleViewProps) {
  const [showTableOfContents, setShowTableOfContents] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false); // Start small, then expand

  // Auto-expand after component mounts for smooth animation
  useEffect(() => {
    const timer = setTimeout(() => {
      setIsExpanded(true);
    }, 50); // Small delay to ensure transition happens
    
    return () => clearTimeout(timer);
  }, []);

  // Parse article content into sections for table of contents
  const sections = [
    { id: 'overview', title: 'Overview' },
    { id: 'getting-started', title: 'Getting Started' },
    { id: 'key-features', title: 'Key Features' },
    { id: 'advanced-usage', title: 'Advanced Usage' },
    { id: 'troubleshooting', title: 'Troubleshooting' },
  ];

  return (
    <div 
      className="fixed flex flex-col bg-white z-[999999] overflow-hidden"
      style={{
        width: isExpanded ? '900px' : '400px',
        height: isExpanded ? 'calc(100vh - 120px)' : 'min(680px, 88vh)',
        bottom: '90px',
        right: '20px',
        borderRadius: '16px',
        boxShadow: '0 16px 40px rgba(0,0,0,0.35)',
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        transformOrigin: 'bottom right'
      }}
    >
      {/* Header Bar */}
      <div 
        className="flex items-center justify-between bg-white"
        style={{
          height: '56px',
          padding: '0 12px',
          borderBottom: '1px solid rgba(0,0,0,0.08)',
          borderTopLeftRadius: '16px',
          borderTopRightRadius: '16px'
        }}
      >
        <Button
          variant="ghost"
          onClick={() => {
            setIsExpanded(false);
            setTimeout(onBack, 300); // Wait for transition to complete
          }}
          className="w-8 h-8 flex items-center justify-center hover:bg-gray-50 rounded-lg transition-colors p-0"
        >
          <ArrowLeft
            size={20}
            strokeWidth={1.5}
            style={{ color: 'rgba(0,0,0,0.8)' }}
          />
        </Button>
        
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => setIsExpanded(!isExpanded)}
            className="w-8 h-8 flex items-center justify-center hover:bg-gray-50 rounded-lg transition-colors p-0"
            title={isExpanded ? "Minimize" : "Expand"}
          >
            {isExpanded ? (
              <Minimize2
                size={18}
                strokeWidth={2}
                style={{ color: 'rgba(0,0,0,0.6)' }}
              />
            ) : (
              <Maximize2
                size={18}
                strokeWidth={2}
                style={{ color: 'rgba(0,0,0,0.6)' }}
              />
            )}
          </Button>

          <Button
            variant="ghost"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center hover:bg-gray-50 rounded-lg transition-colors p-0"
          >
            <X
              size={20}
              strokeWidth={1.5}
              style={{ color: 'rgba(0,0,0,0.8)' }}
            />
          </Button>
        </div>
      </div>

      {/* Article Content */}
      <div className="flex-1 overflow-y-auto bg-white scrollbar-thin">
        {/* Article Header */}
        <div style={{
          padding: '24px 20px 20px 20px',
          borderBottom: '1px solid rgba(0,0,0,0.06)'
        }}>
          <h1 style={{
            fontSize: '24px',
            fontWeight: 600,
            color: '#111827',
            lineHeight: '1.3',
            marginBottom: '12px'
          }}>
            {article.title}
          </h1>
          
          <p style={{
            fontSize: '14px',
            color: '#6B7280',
            lineHeight: '1.5'
          }}>
            Learn about each of our features for customer service.
          </p>
          
          {/* Author Info */}
          <div className="flex items-center gap-3" style={{ marginTop: '16px' }}>
            <div style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              backgroundColor: '#E5E7EB',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}>
              <span style={{
                fontSize: '12px',
                fontWeight: 600,
                color: '#6B7280'
              }}>
                DT
              </span>
            </div>
            <div>
              <p style={{
                fontSize: '13px',
                color: '#374151'
              }}>
                Written by {article.author || 'Des Traynor'}
              </p>
              <p style={{
                fontSize: '12px',
                color: '#9CA3AF'
              }}>
                Updated {article.updatedAt || 'over 4 months ago'}
              </p>
            </div>
          </div>
        </div>

        {/* Table of Contents */}
        <div style={{ padding: '16px 20px' }}>
          <Button
            variant="ghost"
            onClick={() => setShowTableOfContents(!showTableOfContents)}
            className="w-full text-left h-auto"
            style={{
              backgroundColor: '#F9FAFB',
              border: '1px solid #E5E7EB',
              borderRadius: '8px',
              padding: '12px 16px'
            }}
          >
            <div className="flex items-center justify-between">
              <span style={{
                fontSize: '14px',
                fontWeight: 500,
                color: '#111827'
              }}>
                Table of contents
              </span>
              {showTableOfContents ? (
                <ChevronUp size={18} style={{ color: '#6B7280' }} />
              ) : (
                <ChevronDown size={18} style={{ color: '#6B7280' }} />
              )}
            </div>
          </Button>
          
          {showTableOfContents && (
            <div style={{
              marginTop: '12px',
              paddingLeft: '16px'
            }}>
              {sections.map((section, index) => (
                <Button
                  key={section.id}
                  variant="ghost"
                  className="w-full text-left hover:text-blue-600 transition-colors h-auto"
                  style={{
                    padding: '8px 0',
                    fontSize: '14px',
                    color: '#4B5563'
                  }}
                >
                  {index + 1}. {section.title}
                </Button>
              ))}
            </div>
          )}
        </div>

        {/* Article Body */}
        <div style={{ padding: '0 20px 24px 20px' }}>
          <h2 style={{
            fontSize: '20px',
            fontWeight: 600,
            color: '#111827',
            marginBottom: '16px'
          }}>
            Customer Service Suite
          </h2>
          
          <p style={{
            fontSize: '14px',
            color: '#374151',
            lineHeight: '1.6',
            marginBottom: '16px'
          }}>
            The Customer Service Suite combines the #1 AI agent for customer support with a next-gen Helpdesk—built on a single platform that maximizes team efficiency and delivers superior service.
          </p>

          {/* Example Image Placeholder */}
          <div style={{
            width: '100%',
            height: '180px',
            backgroundColor: '#F3F4F6',
            borderRadius: '8px',
            marginBottom: '24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}>
            <span style={{
              fontSize: '13px',
              color: '#9CA3AF'
            }}>
              Product Screenshot
            </span>
          </div>

          <h3 style={{
            fontSize: '18px',
            fontWeight: 600,
            color: '#111827',
            marginBottom: '12px'
          }}>
            AI Agent features
          </h3>
          
          <p style={{
            fontSize: '14px',
            color: '#374151',
            lineHeight: '1.6',
            marginBottom: '16px'
          }}>
            Our AI is the highest-performing AI agent in customer service. It resolves complex issues with safe, accurate, conversational answers—no scripted responses.
          </p>

          <h3 style={{
            fontSize: '18px',
            fontWeight: 600,
            color: '#111827',
            marginBottom: '12px',
            marginTop: '24px'
          }}>
            Key Benefits
          </h3>
          
          <ul style={{
            paddingLeft: '20px',
            marginBottom: '16px'
          }}>
            <li style={{
              fontSize: '14px',
              color: '#374151',
              lineHeight: '1.6',
              marginBottom: '8px'
            }}>
              Instant resolution for common inquiries
            </li>
            <li style={{
              fontSize: '14px',
              color: '#374151',
              lineHeight: '1.6',
              marginBottom: '8px'
            }}>
              24/7 availability for customer support
            </li>
            <li style={{
              fontSize: '14px',
              color: '#374151',
              lineHeight: '1.6',
              marginBottom: '8px'
            }}>
              Seamless handoff to human agents when needed
            </li>
            <li style={{
              fontSize: '14px',
              color: '#374151',
              lineHeight: '1.6'
            }}>
              Continuous learning from interactions
            </li>
          </ul>

          <h3 style={{
            fontSize: '18px',
            fontWeight: 600,
            color: '#111827',
            marginBottom: '12px',
            marginTop: '24px'
          }}>
            Getting Started
          </h3>
          
          <p style={{
            fontSize: '14px',
            color: '#374151',
            lineHeight: '1.6',
            marginBottom: '16px'
          }}>
            To begin using our customer service features, follow these simple steps:
          </p>

          <ol style={{
            paddingLeft: '20px',
            marginBottom: '16px'
          }}>
            <li style={{
              fontSize: '14px',
              color: '#374151',
              lineHeight: '1.6',
              marginBottom: '8px'
            }}>
              Connect your communication channels (email, chat, social)
            </li>
            <li style={{
              fontSize: '14px',
              color: '#374151',
              lineHeight: '1.6',
              marginBottom: '8px'
            }}>
              Configure your AI agent settings and knowledge base
            </li>
            <li style={{
              fontSize: '14px',
              color: '#374151',
              lineHeight: '1.6',
              marginBottom: '8px'
            }}>
              Set up team roles and permissions
            </li>
            <li style={{
              fontSize: '14px',
              color: '#374151',
              lineHeight: '1.6'
            }}>
              Customize your chat widget appearance
            </li>
          </ol>
        </div>
      </div>
      
      {/* Custom Scrollbar Styles */}
      <style jsx>{`
        .scrollbar-thin {
          scrollbar-width: thin;
          scrollbar-color: rgba(156, 163, 175, 0.3) transparent;
        }
        
        .scrollbar-thin::-webkit-scrollbar {
          width: 6px;
        }
        
        .scrollbar-thin::-webkit-scrollbar-track {
          background: transparent;
        }
        
        .scrollbar-thin::-webkit-scrollbar-thumb {
          background-color: rgba(156, 163, 175, 0.3);
          border-radius: 3px;
        }
        
        .scrollbar-thin::-webkit-scrollbar-thumb:hover {
          background-color: rgba(156, 163, 175, 0.5);
        }
      `}</style>
    </div>
  );
}