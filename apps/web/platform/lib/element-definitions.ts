import { ElementCategory, ElementDefinition } from '@/types/builder';

export const elementDefinitions: ElementDefinition[] = [
  // Text Elements
  {
    type: 'heading',
    name: 'Heading',
    icon: 'Type',
    description: 'Add a heading text',
    category: 'text',
    defaultContent: 'Heading Text',
    defaultSettings: {
      fontSize: '2rem',
      fontWeight: '700',
      margin: '0 0 1rem 0'
    },
    presets: [
      {
        id: 'h1',
        name: 'H1 - Page Title',
        preview: 'Page Title',
        settings: { fontSize: '3rem', fontWeight: '800', lineHeight: '1.2' },
        content: 'Page Title'
      },
      {
        id: 'h2',
        name: 'H2 - Section Title',
        preview: 'Section Title',
        settings: { fontSize: '2.5rem', fontWeight: '700', lineHeight: '1.3' },
        content: 'Section Title'
      },
      {
        id: 'h3',
        name: 'H3 - Subsection',
        preview: 'Subsection Title',
        settings: { fontSize: '2rem', fontWeight: '600', lineHeight: '1.4' },
        content: 'Subsection Title'
      },
      {
        id: 'h4',
        name: 'H4 - Card Title',
        preview: 'Card Title',
        settings: { fontSize: '1.5rem', fontWeight: '600', lineHeight: '1.4' },
        content: 'Card Title'
      }
    ],
    configurable: [
      { id: 'content', label: 'Text', type: 'text', category: 'content' },
      { id: 'fontSize', label: 'Font Size', type: 'slider', category: 'style', min: 12, max: 72, step: 1 },
      { id: 'fontWeight', label: 'Font Weight', type: 'select', category: 'style', options: [
        { value: '300', label: 'Light' },
        { value: '400', label: 'Regular' },
        { value: '600', label: 'Semibold' },
        { value: '700', label: 'Bold' },
        { value: '800', label: 'Extra Bold' }
      ]},
      { id: 'color', label: 'Color', type: 'color', category: 'style' },
      { id: 'textAlign', label: 'Alignment', type: 'select', category: 'style', options: [
        { value: 'left', label: 'Left' },
        { value: 'center', label: 'Center' },
        { value: 'right', label: 'Right' }
      ]}
    ]
  },
  {
    type: 'paragraph',
    name: 'Paragraph',
    icon: 'AlignLeft',
    description: 'Add paragraph text',
    category: 'text',
    defaultContent: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.',
    defaultSettings: {
      fontSize: '1rem',
      lineHeight: '1.6',
      margin: '0 0 1rem 0'
    },
    presets: [
      {
        id: 'body',
        name: 'Body Text',
        preview: 'Regular paragraph text for body content.',
        settings: { fontSize: '1rem', lineHeight: '1.6' },
        content: 'Regular paragraph text for body content.'
      },
      {
        id: 'lead',
        name: 'Lead Paragraph',
        preview: 'A lead paragraph stands out from regular paragraphs.',
        settings: { fontSize: '1.25rem', lineHeight: '1.7', fontWeight: '300' },
        content: 'A lead paragraph stands out from regular paragraphs.'
      },
      {
        id: 'small',
        name: 'Small Text',
        preview: 'Small text for captions or notes.',
        settings: { fontSize: '0.875rem', lineHeight: '1.5' },
        content: 'Small text for captions or notes.'
      }
    ]
  },
  
  // Interactive Elements
  {
    type: 'button',
    name: 'Button',
    icon: 'RectangleHorizontal',
    description: 'Add a clickable button',
    category: 'interactive',
    defaultContent: { text: 'Click Me', url: '#' },
    defaultSettings: {
      padding: '0.75rem 1.5rem',
      backgroundColor: '#3b82f6',
      color: '#ffffff',
      borderRadius: '0.375rem',
      fontSize: '1rem',
      fontWeight: '500',
      display: 'inline-block'
    },
    presets: [
      {
        id: 'primary',
        name: 'Primary Button',
        preview: 'Primary Action',
        settings: {
          backgroundColor: '#3b82f6',
          color: '#ffffff',
          padding: '0.75rem 1.5rem',
          borderRadius: '0.375rem'
        },
        content: { text: 'Primary Action', url: '#' }
      },
      {
        id: 'secondary',
        name: 'Secondary Button',
        preview: 'Secondary Action',
        settings: {
          backgroundColor: 'transparent',
          color: '#3b82f6',
          borderWidth: '2px',
          borderStyle: 'solid',
          borderColor: '#3b82f6',
          padding: '0.75rem 1.5rem',
          borderRadius: '0.375rem'
        },
        content: { text: 'Secondary Action', url: '#' }
      },
      {
        id: 'large',
        name: 'Large CTA Button',
        preview: 'Get Started Now',
        settings: {
          backgroundColor: '#10b981',
          color: '#ffffff',
          padding: '1rem 2rem',
          fontSize: '1.125rem',
          borderRadius: '0.5rem'
        },
        content: { text: 'Get Started Now', url: '#' }
      },
      {
        id: 'ghost',
        name: 'Ghost Button',
        preview: 'Learn More',
        settings: {
          backgroundColor: 'transparent',
          color: '#6b7280',
          padding: '0.5rem 1rem',
          borderRadius: '0.375rem'
        },
        content: { text: 'Learn More', url: '#' }
      }
    ],
    configurable: [
      { id: 'text', label: 'Button Text', type: 'text', category: 'content' },
      { id: 'url', label: 'Link URL', type: 'text', category: 'content' },
      { id: 'backgroundColor', label: 'Background', type: 'color', category: 'style' },
      { id: 'color', label: 'Text Color', type: 'color', category: 'style' },
      { id: 'borderRadius', label: 'Roundness', type: 'slider', category: 'style', min: 0, max: 50, step: 1 }
    ]
  },

  // Media Elements
  {
    type: 'image',
    name: 'Image',
    icon: 'Image',
    description: 'Add an image',
    category: 'media',
    defaultContent: { src: 'https://via.placeholder.com/400x300', alt: 'Placeholder' },
    defaultSettings: {
      width: '100%',
      height: 'auto',
      borderRadius: '0.375rem'
    },
    presets: [
      {
        id: 'full-width',
        name: 'Full Width Image',
        settings: { width: '100%', height: 'auto' },
        content: { src: 'https://via.placeholder.com/1200x600', alt: 'Full width image' }
      },
      {
        id: 'rounded',
        name: 'Rounded Image',
        settings: { width: '100%', borderRadius: '1rem' },
        content: { src: 'https://via.placeholder.com/400x400', alt: 'Rounded image' }
      },
      {
        id: 'circle',
        name: 'Circle Avatar',
        settings: { width: '200px', height: '200px', borderRadius: '50%' },
        content: { src: 'https://via.placeholder.com/200x200', alt: 'Circle image' }
      },
      {
        id: 'product',
        name: 'Product Image',
        settings: { width: '100%', height: '300px', borderRadius: '0.5rem' },
        content: { src: 'https://via.placeholder.com/400x400', alt: 'Product image' }
      }
    ],
    configurable: [
      { id: 'src', label: 'Image URL', type: 'text', category: 'content' },
      { id: 'alt', label: 'Alt Text', type: 'text', category: 'content' },
      { id: 'width', label: 'Width', type: 'text', category: 'layout' },
      { id: 'height', label: 'Height', type: 'text', category: 'layout' },
      { id: 'borderRadius', label: 'Border Radius', type: 'slider', category: 'style', min: 0, max: 50, step: 1 }
    ]
  },
  {
    type: 'video',
    name: 'Video',
    icon: 'Play',
    description: 'Embed a video',
    category: 'media',
    defaultContent: { src: '', type: 'youtube' },
    defaultSettings: {
      width: '100%',
      height: '400px',
      borderRadius: '0.375rem'
    },
    presets: [
      {
        id: 'youtube',
        name: 'YouTube Video',
        settings: { width: '100%', height: '400px' },
        content: { type: 'youtube', videoId: 'dQw4w9WgXcQ' }
      },
      {
        id: 'vimeo',
        name: 'Vimeo Video',
        settings: { width: '100%', height: '400px' },
        content: { type: 'vimeo', videoId: '347119375' }
      },
      {
        id: 'hero-video',
        name: 'Hero Video',
        settings: { width: '100%', height: '600px', borderRadius: '0' },
        content: { type: 'youtube', videoId: 'dQw4w9WgXcQ' }
      }
    ]
  },

  // Layout Elements
  {
    type: 'container',
    name: 'Container',
    icon: 'Square',
    description: 'Container for other elements',
    category: 'layout',
    defaultSettings: {
      padding: '2rem',
      display: 'block',
      width: '100%'
    },
    presets: [
      {
        id: 'section',
        name: 'Section Container',
        settings: { padding: '4rem 2rem', backgroundColor: '#f9fafb' }
      },
      {
        id: 'card',
        name: 'Card Container',
        settings: { 
          padding: '1.5rem',
          backgroundColor: '#ffffff',
          borderRadius: '0.5rem',
          boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)'
        }
      },
      {
        id: 'centered',
        name: 'Centered Container',
        settings: { 
          padding: '2rem',
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center'
        }
      },
      {
        id: 'max-width',
        name: 'Max Width Container',
        settings: { 
          padding: '2rem',
          width: '100%',
          customStyles: 'max-width: 1200px; margin: 0 auto;'
        }
      }
    ]
  },
  {
    type: 'row',
    name: 'Row',
    icon: 'Columns',
    description: 'Horizontal layout container',
    category: 'layout',
    defaultSettings: {
      display: 'flex',
      flexDirection: 'row',
      gap: '1rem',
      width: '100%'
    },
    presets: [
      {
        id: 'two-column',
        name: 'Two Columns',
        settings: { display: 'grid', gridColumns: 2, gap: '2rem' },
        children: [
          { id: 'col1', type: 'column', settings: { flex: '1' }, content: null, children: [] },
          { id: 'col2', type: 'column', settings: { flex: '1' }, content: null, children: [] }
        ]
      },
      {
        id: 'three-column',
        name: 'Three Columns',
        settings: { display: 'grid', gridColumns: 3, gap: '2rem' },
        children: [
          { id: 'col1', type: 'column', settings: { flex: '1' }, content: null, children: [] },
          { id: 'col2', type: 'column', settings: { flex: '1' }, content: null, children: [] },
          { id: 'col3', type: 'column', settings: { flex: '1' }, content: null, children: [] }
        ]
      },
      {
        id: 'four-column',
        name: 'Four Columns',
        settings: { display: 'grid', gridColumns: 4, gap: '1.5rem' },
        children: [
          { id: 'col1', type: 'column', settings: { flex: '1' }, content: null, children: [] },
          { id: 'col2', type: 'column', settings: { flex: '1' }, content: null, children: [] },
          { id: 'col3', type: 'column', settings: { flex: '1' }, content: null, children: [] },
          { id: 'col4', type: 'column', settings: { flex: '1' }, content: null, children: [] }
        ]
      },
      {
        id: 'sidebar-layout',
        name: 'Sidebar Layout',
        settings: { display: 'flex', gap: '2rem' },
        children: [
          { id: 'sidebar', type: 'column', settings: { width: '300px' }, content: null, children: [] },
          { id: 'main', type: 'column', settings: { flex: '1' }, content: null, children: [] }
        ]
      }
    ]
  },
  {
    type: 'column',
    name: 'Column',
    icon: 'RectangleVertical',
    description: 'Vertical layout container',
    category: 'layout',
    defaultSettings: {
      display: 'flex',
      flexDirection: 'column',
      gap: '1rem',
      flex: '1'
    }
  },
  {
    type: 'divider',
    name: 'Line / Divider',
    icon: 'Minus',
    description: 'Horizontal line separator',
    category: 'layout',
    defaultContent: null,
    defaultSettings: {
      width: '100%',
      height: '1px',
      backgroundColor: '#e5e7eb',
      margin: '2rem 0'
    },
    presets: [
      {
        id: 'thin-line',
        name: 'Thin Line',
        preview: '',
        settings: { 
          width: '100%',
          height: '1px',
          backgroundColor: '#e5e7eb',
          margin: '1rem 0'
        },
        content: null
      },
      {
        id: 'thick-line',
        name: 'Thick Line',
        preview: '',
        settings: { 
          width: '100%',
          height: '3px',
          backgroundColor: '#9ca3af',
          margin: '2rem 0'
        },
        content: null
      },
      {
        id: 'dashed-line',
        name: 'Dashed Line',
        preview: '',
        settings: { 
          width: '100%',
          height: '0',
          borderTop: '2px dashed #9ca3af',
          margin: '2rem 0'
        },
        content: null
      },
      {
        id: 'dotted-line',
        name: 'Dotted Line',
        preview: '',
        settings: { 
          width: '100%',
          height: '0',
          borderTop: '2px dotted #9ca3af',
          margin: '2rem 0'
        },
        content: null
      },
      {
        id: 'gradient-line',
        name: 'Gradient Line',
        preview: '',
        settings: { 
          width: '100%',
          height: '2px',
          backgroundColor: '#3b82f6',
          margin: '2rem 0'
        },
        content: null
      },
      {
        id: 'short-centered',
        name: 'Short Centered',
        preview: '',
        settings: { 
          width: '100px',
          height: '2px',
          backgroundColor: '#3b82f6',
          margin: '2rem auto'
        },
        content: null
      }
    ],
    configurable: [
      { id: 'width', label: 'Width', type: 'text', category: 'style' },
      { id: 'height', label: 'Thickness', type: 'slider', category: 'style', min: 1, max: 10, step: 1 },
      { id: 'backgroundColor', label: 'Color', type: 'color', category: 'style' },
      { id: 'margin', label: 'Margin', type: 'text', category: 'style' }
    ]
  },

  // Advanced Components
  {
    type: 'card',
    name: 'Card',
    icon: 'CreditCard',
    description: 'Content card with image and text',
    category: 'components',
    defaultSettings: {
      padding: '0',
      backgroundColor: '#ffffff',
      borderRadius: '0.5rem',
      boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1)',
      customStyles: 'overflow: hidden;'
    },
    presets: [
      {
        id: 'blog-card',
        name: 'Blog Card',
        settings: { backgroundColor: '#ffffff', borderRadius: '0.5rem' },
        children: [
          { 
            id: 'img', 
            type: 'image', 
            settings: { width: '100%', height: '200px' }, 
            content: { src: 'https://via.placeholder.com/400x200', alt: 'Blog image' }, 
            children: [] 
          },
          { 
            id: 'content', 
            type: 'container', 
            settings: { padding: '1.5rem' }, 
            content: null, 
            children: [
              { 
                id: 'title', 
                type: 'heading', 
                settings: { fontSize: '1.5rem', margin: '0 0 0.5rem 0' }, 
                content: 'Blog Post Title', 
                children: [] 
              },
              { 
                id: 'desc', 
                type: 'paragraph', 
                settings: { fontSize: '1rem' }, 
                content: 'This is a brief description of the blog post content.', 
                children: [] 
              },
              { 
                id: 'btn', 
                type: 'button', 
                settings: { marginTop: '1rem' }, 
                content: { text: 'Read More', url: '#' }, 
                children: [] 
              }
            ]
          }
        ]
      },
      {
        id: 'product-card',
        name: 'Product Card',
        settings: { backgroundColor: '#ffffff', borderRadius: '0.5rem' },
        children: [
          { 
            id: 'img', 
            type: 'image', 
            settings: { width: '100%', height: '250px' }, 
            content: { src: 'https://via.placeholder.com/300x300', alt: 'Product' }, 
            children: [] 
          },
          { 
            id: 'content', 
            type: 'container', 
            settings: { padding: '1rem' }, 
            content: null, 
            children: [
              { 
                id: 'title', 
                type: 'heading', 
                settings: { fontSize: '1.25rem', margin: '0 0 0.25rem 0' }, 
                content: 'Product Name', 
                children: [] 
              },
              { 
                id: 'price', 
                type: 'text', 
                settings: { fontSize: '1.5rem', fontWeight: '700', color: '#10b981' }, 
                content: '$99.99', 
                children: [] 
              },
              { 
                id: 'btn', 
                type: 'button', 
                settings: { width: '100%', marginTop: '1rem' }, 
                content: { text: 'Add to Cart' }, 
                children: [] 
              }
            ]
          }
        ]
      },
      {
        id: 'feature-card',
        name: 'Feature Card',
        settings: { backgroundColor: '#ffffff', borderRadius: '0.5rem', padding: '2rem' },
        children: [
          { 
            id: 'icon', 
            type: 'icon', 
            settings: { fontSize: '3rem', color: '#3b82f6', margin: '0 0 1rem 0' }, 
            content: { icon: 'star' }, 
            children: [] 
          },
          { 
            id: 'title', 
            type: 'heading', 
            settings: { fontSize: '1.5rem', margin: '0 0 0.5rem 0' }, 
            content: 'Feature Title', 
            children: [] 
          },
          { 
            id: 'desc', 
            type: 'paragraph', 
            settings: { fontSize: '1rem', color: '#6b7280' }, 
            content: 'Description of this amazing feature that helps users.', 
            children: [] 
          }
        ]
      }
    ]
  },
  {
    type: 'accordion',
    name: 'Accordion',
    icon: 'ChevronDown',
    description: 'Expandable content sections',
    category: 'components',
    defaultContent: {
      items: [
        { title: 'Section 1', content: 'Content for section 1' },
        { title: 'Section 2', content: 'Content for section 2' },
        { title: 'Section 3', content: 'Content for section 3' }
      ]
    },
    defaultSettings: {
      width: '100%',
      borderRadius: '0.375rem'
    },
    presets: [
      {
        id: 'faq',
        name: 'FAQ Accordion',
        settings: { width: '100%' },
        content: {
          items: [
            { title: 'What is your return policy?', content: 'We offer a 30-day return policy for all products.' },
            { title: 'How long does shipping take?', content: 'Standard shipping takes 5-7 business days.' },
            { title: 'Do you ship internationally?', content: 'Yes, we ship to most countries worldwide.' }
          ]
        }
      }
    ]
  },
  {
    type: 'tabs',
    name: 'Tabs',
    icon: 'Tabs',
    description: 'Tabbed content container',
    category: 'components',
    defaultContent: {
      tabs: [
        { label: 'Tab 1', content: 'Content for tab 1' },
        { label: 'Tab 2', content: 'Content for tab 2' },
        { label: 'Tab 3', content: 'Content for tab 3' }
      ]
    },
    defaultSettings: {
      width: '100%'
    },
    presets: [
      {
        id: 'product-tabs',
        name: 'Product Info Tabs',
        settings: { width: '100%' },
        content: {
          tabs: [
            { label: 'Description', content: 'Product description goes here...' },
            { label: 'Specifications', content: 'Technical specifications...' },
            { label: 'Reviews', content: 'Customer reviews...' }
          ]
        }
      }
    ]
  },
  {
    type: 'carousel',
    name: 'Carousel',
    icon: 'ArrowLeftRight',
    description: 'Image or content slider',
    category: 'components',
    defaultContent: {
      slides: [
        { type: 'image', src: 'https://via.placeholder.com/800x400/3b82f6', alt: 'Slide 1' },
        { type: 'image', src: 'https://via.placeholder.com/800x400/10b981', alt: 'Slide 2' },
        { type: 'image', src: 'https://via.placeholder.com/800x400/8b5cf6', alt: 'Slide 3' }
      ],
      autoplay: true,
      interval: 5000
    },
    defaultSettings: {
      width: '100%',
      height: '400px',
      borderRadius: '0.5rem'
    }
  },

  // Form Elements
  {
    type: 'form',
    name: 'Form',
    icon: 'FileText',
    description: 'Form container',
    category: 'forms',
    defaultContent: { action: '#', method: 'post' },
    defaultSettings: {
      width: '100%',
      padding: '1.5rem',
      display: 'flex',
      flexDirection: 'column',
      gap: '1rem'
    },
    presets: [
      {
        id: 'contact-form',
        name: 'Contact Form',
        settings: { padding: '2rem', backgroundColor: '#f9fafb', borderRadius: '0.5rem' },
        children: [
          { 
            id: 'name', 
            type: 'input', 
            settings: {}, 
            content: { label: 'Name', placeholder: 'Your name', type: 'text' }, 
            children: [] 
          },
          { 
            id: 'email', 
            type: 'input', 
            settings: {}, 
            content: { label: 'Email', placeholder: 'your@email.com', type: 'email' }, 
            children: [] 
          },
          { 
            id: 'message', 
            type: 'textarea', 
            settings: {}, 
            content: { label: 'Message', placeholder: 'Your message...', rows: 4 }, 
            children: [] 
          },
          { 
            id: 'submit', 
            type: 'button', 
            settings: {}, 
            content: { text: 'Send Message' }, 
            children: [] 
          }
        ]
      },
      {
        id: 'newsletter-form',
        name: 'Newsletter Form',
        settings: { display: 'flex', flexDirection: 'row', gap: '0.5rem' },
        children: [
          { 
            id: 'email', 
            type: 'input', 
            settings: { flex: '1' }, 
            content: { placeholder: 'Enter your email', type: 'email' }, 
            children: [] 
          },
          { 
            id: 'submit', 
            type: 'button', 
            settings: {}, 
            content: { text: 'Subscribe' }, 
            children: [] 
          }
        ]
      }
    ]
  },
  {
    type: 'input',
    name: 'Input Field',
    icon: 'TextCursor',
    description: 'Text input field',
    category: 'forms',
    defaultContent: { label: 'Label', placeholder: 'Enter text...', type: 'text' },
    defaultSettings: {
      width: '100%',
      padding: '0.5rem',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: '#d1d5db',
      borderRadius: '0.375rem'
    }
  },
  {
    type: 'textarea',
    name: 'Textarea',
    icon: 'AlignJustify',
    description: 'Multi-line text input',
    category: 'forms',
    defaultContent: { label: 'Label', placeholder: 'Enter text...', rows: 4 },
    defaultSettings: {
      width: '100%',
      padding: '0.5rem',
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: '#d1d5db',
      borderRadius: '0.375rem'
    }
  },

  // Utility Elements
  {
    type: 'divider',
    name: 'Divider',
    icon: 'Minus',
    description: 'Horizontal line divider',
    category: 'utility',
    defaultSettings: {
      width: '100%',
      height: '1px',
      backgroundColor: '#e5e7eb',
      margin: '2rem 0'
    },
    presets: [
      {
        id: 'thin',
        name: 'Thin Line',
        settings: { height: '1px', backgroundColor: '#e5e7eb' }
      },
      {
        id: 'thick',
        name: 'Thick Line',
        settings: { height: '3px', backgroundColor: '#9ca3af' }
      },
      {
        id: 'dotted',
        name: 'Dotted Line',
        settings: { borderTop: '2px dotted #9ca3af', height: '0' }
      }
    ]
  },
  {
    type: 'spacer',
    name: 'Spacer',
    icon: 'Maximize2',
    description: 'Empty space for layout',
    category: 'utility',
    defaultSettings: {
      height: '2rem',
      width: '100%'
    },
    presets: [
      {
        id: 'small',
        name: 'Small Space',
        settings: { height: '1rem' }
      },
      {
        id: 'medium',
        name: 'Medium Space',
        settings: { height: '2rem' }
      },
      {
        id: 'large',
        name: 'Large Space',
        settings: { height: '4rem' }
      }
    ]
  },
  {
    type: 'icon',
    name: 'Icon',
    icon: 'Star',
    description: 'Add an icon',
    category: 'utility',
    defaultContent: { icon: 'star' },
    defaultSettings: {
      fontSize: '1.5rem',
      color: 'currentColor'
    }
  },
  
  // Components/Collections
  {
    type: 'productRowComponent',
    name: 'Product Row Collection',
    icon: 'Layers',
    description: '5 products in a row with navigation',
    category: 'components',
    defaultContent: {
      title: 'More from',
      brand: 'rhode',
      products: [
        { id: '1', name: '', image: '/api/placeholder/220/293' },
        { id: '2', name: '', image: '/api/placeholder/220/293' },
        { id: '3', name: '', image: '/api/placeholder/220/293' },
        { id: '4', name: '', image: '/api/placeholder/220/293' },
        { id: '5', name: '', image: '/api/placeholder/220/293' },
        { id: '6', name: '', image: '/api/placeholder/220/293' },
        { id: '7', name: '', image: '/api/placeholder/220/293' },
        { id: '8', name: '', image: '/api/placeholder/220/293' }
      ]
    },
    defaultSettings: {
      width: '100%',
      padding: '3rem 2rem'
    },
    presets: [
      {
        id: 'rhode-style',
        name: 'Rhode Style',
        preview: 'Clean minimal product row',
        settings: { padding: '3rem 2rem' },
        content: { title: 'More from', brand: 'rhode' }
      },
      {
        id: 'featured-products',
        name: 'Featured Products',
        preview: 'Featured products showcase',
        settings: { padding: '4rem 2rem' },
        content: { title: 'Featured from', brand: 'our collection' }
      },
      {
        id: 'bestsellers',
        name: 'Best Sellers',
        preview: 'Top selling products',
        settings: { padding: '3rem 2rem' },
        content: { title: 'Best sellers from', brand: 'this month' }
      }
    ],
    configurable: [
      { id: 'title', label: 'Title', type: 'text', category: 'content' },
      { id: 'brand', label: 'Brand', type: 'text', category: 'content' }
    ]
  },
  // Commerce Elements
  {
    type: 'productCarousel',
    name: 'Product Carousel',
    icon: 'Package2',
    description: 'Scrollable product showcase',
    category: 'commerce',
    defaultContent: {
      title: 'More from our collection',
      products: [
        { id: '1', name: 'Product 1', brand: 'Brand', image: '/api/placeholder/200/200', price: 29.99 },
        { id: '2', name: 'Product 2', brand: 'Brand', image: '/api/placeholder/200/200', price: 39.99 },
        { id: '3', name: 'Product 3', brand: 'Brand', image: '/api/placeholder/200/200', price: 49.99 },
        { id: '4', name: 'Product 4', brand: 'Brand', image: '/api/placeholder/200/200', price: 59.99 },
        { id: '5', name: 'Product 5', brand: 'Brand', image: '/api/placeholder/200/200', price: 69.99 },
        { id: '6', name: 'Product 6', brand: 'Brand', image: '/api/placeholder/200/200', price: 79.99 }
      ]
    },
    defaultSettings: {
      width: '100%',
      padding: '2rem 0'
    },
    configurable: [
      { id: 'title', label: 'Title', type: 'text', category: 'content' }
    ]
  },
  {
    type: 'productRow',
    name: 'Product Row',
    icon: 'Layers',
    description: '5 products in a row with navigation',
    category: 'commerce',
    defaultContent: {
      title: 'More from',
      brand: 'rhode',
      products: [
        { id: '1', name: '', image: '/api/placeholder/220/293' },
        { id: '2', name: '', image: '/api/placeholder/220/293' },
        { id: '3', name: '', image: '/api/placeholder/220/293' },
        { id: '4', name: '', image: '/api/placeholder/220/293' },
        { id: '5', name: '', image: '/api/placeholder/220/293' },
        { id: '6', name: '', image: '/api/placeholder/220/293' },
        { id: '7', name: '', image: '/api/placeholder/220/293' },
        { id: '8', name: '', image: '/api/placeholder/220/293' }
      ]
    },
    defaultSettings: {
      width: '100%',
      padding: '3rem 2rem'
    },
    configurable: [
      { id: 'title', label: 'Title', type: 'text', category: 'content' },
      { id: 'brand', label: 'Brand', type: 'text', category: 'content' }
    ]
  },
  {
    type: 'productGrid',
    name: 'Product Grid',
    icon: 'Grid',
    description: 'Grid layout for products',
    category: 'commerce',
    defaultContent: {
      title: 'Featured Products',
      columns: 4,
      products: []
    },
    defaultSettings: {
      width: '100%',
      gap: '1rem'
    }
  },
  {
    type: 'productCard',
    name: 'Product Card',
    icon: 'ShoppingBag',
    description: 'Single product display',
    category: 'commerce',
    defaultContent: {
      name: 'Product Name',
      price: 99.99,
      image: '/api/placeholder/200/200'
    },
    defaultSettings: {
      width: '250px',
      borderRadius: '0.5rem'
    }
  }
];

export const elementCategories: ElementCategory[] = [
  {
    id: 'text',
    name: 'Text',
    icon: 'Type',
    elements: elementDefinitions.filter(e => e.category === 'text')
  },
  {
    id: 'commerce',
    name: 'Commerce',
    icon: 'ShoppingBag',
    elements: elementDefinitions.filter(e => e.category === 'commerce')
  },
  {
    id: 'interactive',
    name: 'Interactive',
    icon: 'MousePointer',
    elements: elementDefinitions.filter(e => e.category === 'interactive')
  },
  {
    id: 'media',
    name: 'Media',
    icon: 'Image',
    elements: elementDefinitions.filter(e => e.category === 'media')
  },
  {
    id: 'layout',
    name: 'Layout',
    icon: 'Layout',
    elements: elementDefinitions.filter(e => e.category === 'layout')
  },
  {
    id: 'components',
    name: 'Components',
    icon: 'Package',
    elements: elementDefinitions.filter(e => e.category === 'components')
  },
  {
    id: 'forms',
    name: 'Forms',
    icon: 'FileText',
    elements: elementDefinitions.filter(e => e.category === 'forms')
  },
  {
    id: 'utility',
    name: 'Utility',
    icon: 'Tool',
    elements: elementDefinitions.filter(e => e.category === 'utility')
  }
];
