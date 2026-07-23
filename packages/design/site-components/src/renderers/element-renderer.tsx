"use client";

import React from 'react';
import { Element, ElementSettings, RenderMode } from '../types';
import { cn } from '@weldsuite/ui/lib/utils';
import Image from 'next/image';

interface ElementRendererProps {
  element: Element;
  mode?: RenderMode;
  onSelect?: () => void;
  onUpdate?: (updates: Partial<Element>) => void;
}

export function ElementRenderer({
  element,
  mode = 'live',
  onSelect,
  onUpdate
}: ElementRendererProps) {
  const { type, content, settings, children } = element;
  const isEditing = mode === 'edit';

  // Convert settings to CSS styles
  const styles: React.CSSProperties = {
    width: settings.width,
    height: settings.height,
    padding: settings.padding,
    margin: settings.margin,
    position: settings.position as any,
    display: settings.display as any,
    flexDirection: settings.flexDirection as any,
    justifyContent: settings.justifyContent as any,
    alignItems: settings.alignItems as any,
    gap: settings.gap,
    fontSize: settings.fontSize,
    fontWeight: settings.fontWeight,
    fontFamily: settings.fontFamily,
    lineHeight: settings.lineHeight,
    letterSpacing: settings.letterSpacing,
    textAlign: settings.textAlign as any,
    textDecoration: settings.textDecoration,
    textTransform: settings.textTransform as any,
    color: settings.color,
    backgroundColor: settings.backgroundColor,
    borderColor: settings.borderColor,
    borderWidth: settings.borderWidth,
    borderStyle: settings.borderStyle as any,
    borderRadius: settings.borderRadius,
    boxShadow: settings.boxShadow,
    opacity: settings.opacity,
    filter: settings.filter,
    backdropFilter: settings.backdropFilter,
    gridTemplateColumns: settings.gridColumns ? `repeat(${settings.gridColumns}, 1fr)` : undefined,
    gridTemplateRows: settings.gridRows ? `repeat(${settings.gridRows}, 1fr)` : undefined,
    left: settings.left,
    top: settings.top,
    right: settings.right,
    bottom: settings.bottom,
  };

  // Apply custom styles if provided
  if (settings.customStyles) {
    const customStyles = settings.customStyles.split(';').reduce((acc, style) => {
      const [key, value] = style.split(':').map(s => s.trim());
      if (key && value) {
        const camelKey = key.replace(/-([a-z])/g, g => g[1]?.toUpperCase() || '');
        (acc as any)[camelKey] = value;
      }
      return acc;
    }, {} as React.CSSProperties);
    Object.assign(styles, customStyles);
  }

  const wrapperClasses = cn(
    isEditing && "relative hover:outline hover:outline-2 hover:outline-blue-500 hover:outline-offset-2 cursor-pointer",
    element.locked && "pointer-events-none opacity-50",
    !element.visible && "hidden"
  );

  const handleClick = (e: React.MouseEvent) => {
    if (isEditing && onSelect) {
      e.stopPropagation();
      onSelect();
    }
  };

  const renderElement = () => {
    switch (type) {
      case 'heading':
        const HeadingTag = (content?.tag || 'h2') as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
        return (
          <HeadingTag
            style={styles}
            className={wrapperClasses}
            onClick={handleClick}
          >
            {content?.text || content || 'Heading'}
          </HeadingTag>
        );

      case 'paragraph':
        return (
          <p
            style={styles}
            className={wrapperClasses}
            onClick={handleClick}
          >
            {content || 'Paragraph text'}
          </p>
        );

      case 'text':
        return (
          <span
            style={styles}
            className={wrapperClasses}
            onClick={handleClick}
          >
            {content || 'Text'}
          </span>
        );

      case 'button':
        return (
          <button
            style={styles}
            className={cn(wrapperClasses, "cursor-pointer hover:opacity-90 transition-opacity")}
            onClick={handleClick}
          >
            {content?.text || content || 'Button'}
          </button>
        );

      case 'link':
        return (
          <a
            href={isEditing ? '#' : (content?.url || '#')}
            style={styles}
            className={cn(wrapperClasses, "hover:underline")}
            onClick={isEditing ? handleClick : undefined}
          >
            {content?.text || content || 'Link'}
          </a>
        );

      case 'image':
        if (content?.src || content?.url) {
          return (
            <div style={styles} className={wrapperClasses} onClick={handleClick}>
              <Image
                src={content?.src || content?.url}
                alt={content?.alt || ''}
                width={parseInt(settings.width || '400')}
                height={parseInt(settings.height || '300')}
                className="w-full h-auto"
              />
            </div>
          );
        }
        return (
          <div
            style={{...styles, backgroundColor: '#f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'center'}}
            className={wrapperClasses}
            onClick={handleClick}
          >
            <span className="text-muted-foreground">Image</span>
          </div>
        );

      case 'video':
        if (content?.src || content?.url) {
          return (
            <div style={styles} className={wrapperClasses} onClick={handleClick}>
              <video
                src={content?.src || content?.url}
                controls
                className="w-full h-auto"
              >
                Your browser does not support the video tag.
              </video>
            </div>
          );
        }
        return (
          <div
            style={{...styles, backgroundColor: '#f0f0f0', display: 'flex', alignItems: 'center', justifyContent: 'center'}}
            className={wrapperClasses}
            onClick={handleClick}
          >
            <span className="text-muted-foreground">Video</span>
          </div>
        );

      case 'container':
      case 'section':
        return (
          <div style={styles} className={wrapperClasses} onClick={handleClick}>
            {children?.map((child) => (
              <ElementRenderer
                key={child.id}
                element={child}
                mode={mode}
                onSelect={() => onSelect?.()}
                onUpdate={onUpdate}
              />
            ))}
          </div>
        );

      case 'row':
        return (
          <div
            style={{...styles, display: 'flex', flexDirection: 'row'}}
            className={wrapperClasses}
            onClick={handleClick}
          >
            {children?.map((child) => (
              <ElementRenderer
                key={child.id}
                element={child}
                mode={mode}
                onSelect={() => onSelect?.()}
                onUpdate={onUpdate}
              />
            ))}
          </div>
        );

      case 'column':
        return (
          <div
            style={{...styles, display: 'flex', flexDirection: 'column'}}
            className={wrapperClasses}
            onClick={handleClick}
          >
            {children?.map((child) => (
              <ElementRenderer
                key={child.id}
                element={child}
                mode={mode}
                onSelect={() => onSelect?.()}
                onUpdate={onUpdate}
              />
            ))}
          </div>
        );

      case 'divider':
        return (
          <hr
            style={styles}
            className={cn(wrapperClasses, "border-t")}
            onClick={handleClick}
          />
        );

      case 'spacer':
        return (
          <div
            style={{...styles, minHeight: settings.height || '20px'}}
            className={wrapperClasses}
            onClick={handleClick}
          />
        );

      default:
        return (
          <div style={styles} className={wrapperClasses} onClick={handleClick}>
            <span className="text-muted-foreground">Unknown element: {type}</span>
          </div>
        );
    }
  };

  return renderElement();
}
