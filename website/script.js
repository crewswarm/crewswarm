document.addEventListener('DOMContentLoaded', () => {
  initMobileNav();
  initHorizontalPreviewRail();
  initDocsFeed();
});

function initMobileNav() {
  if (window.__crewswarmNavInit) return;

  const btn = document.getElementById('navHamburger');
  const links = document.getElementById('navLinks');
  if (!btn || !links) return;

  window.__crewswarmNavInit = true;

  const closeNav = () => {
    links.classList.remove('open');
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('nav-open');
  };

  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = links.classList.toggle('open');
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('nav-open', open);
  });

  links.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', closeNav);
  });

  document.addEventListener('click', (event) => {
    if (!btn.contains(event.target) && !links.contains(event.target)) {
      closeNav();
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) closeNav();
  });
}

function initHorizontalPreviewRail() {
  const rail = document.getElementById('dashboardPreviewRail');
  if (!rail) return;

  const slides = Array.from(rail.querySelectorAll('.preview-slide'));
  const tabs = Array.from(document.querySelectorAll('.preview-tab'));
  const nextButton = document.querySelector('[data-scroll-target="dashboardPreviewRail"]');

  const syncCurrentSlide = () => {
    const railCenter = rail.scrollLeft + rail.clientWidth / 2;
    let currentSlide = slides[0];
    let smallestDistance = Number.POSITIVE_INFINITY;

    slides.forEach((slide) => {
      const slideCenter = slide.offsetLeft + slide.offsetWidth / 2;
      const distance = Math.abs(slideCenter - railCenter);
      const isCurrent = distance < smallestDistance;
      slide.classList.toggle('is-current', false);
      if (isCurrent) {
        smallestDistance = distance;
        currentSlide = slide;
      }
    });

    if (currentSlide) {
      currentSlide.classList.add('is-current');
      const panelId = currentSlide.dataset.previewPanel;
      tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.target === panelId));
    }
  };

  rail.addEventListener('scroll', () => {
    window.requestAnimationFrame(syncCurrentSlide);
  }, { passive: true });

  rail.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    rail.scrollBy({ left: event.deltaY, behavior: 'smooth' });
  }, { passive: false });

  if (nextButton) {
    nextButton.addEventListener('click', () => {
      const currentIndex = slides.findIndex((slide) => slide.classList.contains('is-current'));
      const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % slides.length : 0;
      rail.scrollTo({
        left: slides[nextIndex].offsetLeft - rail.offsetLeft,
        behavior: 'smooth'
      });
    });
  }

  syncCurrentSlide();
}

function initDocsFeed() {
  const feed = document.getElementById('docsFeed');
  const sentinel = document.getElementById('docsFeedSentinel');
  const status = document.getElementById('docsFeedStatus');
  if (!feed || !sentinel || !status || !('IntersectionObserver' in window)) return;

  const docsQueue = [
    {
      icon: '🧭',
      title: 'Canonical Runtime Docs',
      description: 'Follow the current source of truth for routing, runtime identity, shared memory, and testing rules.',
      links: [
        { label: 'Canonical Docs Map', href: 'https://github.com/crewswarm/crewswarm/blob/main/docs/CANONICAL/README.md' },
        { label: 'Routing', href: 'https://github.com/crewswarm/crewswarm/blob/main/docs/CANONICAL/ROUTING.md' },
        { label: 'Runtime', href: 'https://github.com/crewswarm/crewswarm/blob/main/docs/CANONICAL/RUNTIME.md' }
      ]
    },
    {
      icon: '🧠',
      title: 'Memory & Context',
      description: 'Understand shared memory layers, migration, retrieval, and project message search behavior.',
      links: [
        { label: 'Memory', href: 'https://github.com/crewswarm/crewswarm/blob/main/docs/CANONICAL/MEMORY.md' },
        { label: 'Shared Memory Integration', href: 'https://github.com/crewswarm/crewswarm/blob/main/SHARED-MEMORY-INTEGRATION.md' },
        { label: 'Chat History and RAG', href: 'https://github.com/crewswarm/crewswarm/blob/main/CHAT-HISTORY-AND-RAG-COMPLETE.md' }
      ]
    },
    {
      icon: '🧪',
      title: 'Testing & Verification',
      description: 'Smoke tests, verification rules, and fast health checks for dashboard, agents, and MCP surfaces.',
      links: [
        { label: 'Canonical Testing', href: 'https://github.com/crewswarm/crewswarm/blob/main/docs/CANONICAL/TESTING.md' },
        { label: 'Health Check Script', href: 'https://github.com/crewswarm/crewswarm/blob/main/scripts/health-check.mjs' },
        { label: 'Dashboard Validator', href: 'https://github.com/crewswarm/crewswarm/blob/main/scripts/check-dashboard.mjs' }
      ]
    },
    {
      icon: '🚢',
      title: 'Deployment Paths',
      description: 'Choose between Docker, local development, Studio, and bridge integrations without digging through the repo.',
      links: [
        { label: 'Docker Guide', href: 'https://github.com/crewswarm/crewswarm/blob/main/docs/docker.md' },
        { label: 'Deploy Page', href: 'deploy.html' },
        { label: 'Studio Quickstart', href: 'https://github.com/crewswarm/crewswarm/blob/main/STUDIO-CLI-QUICKSTART.md' }
      ]
    },
    {
      icon: '📋',
      title: 'API & Integrations',
      description: 'OpenAPI spec for dashboard, crew-lead, and headless integrations.',
      links: [
        { label: 'OpenAPI Spec (JSON)', href: 'https://github.com/crewswarm/crewswarm/blob/main/crew-cli/docs/openapi.unified.v1.json' },
        { label: 'API-UNIFIED-v1', href: 'https://github.com/crewswarm/crewswarm/blob/main/crew-cli/docs/API-UNIFIED-v1.md' }
      ]
    }
  ];

  let nextBatchIndex = 0;
  let loading = false;

  const renderDocCard = (item, indexInBatch) => {
    const card = document.createElement('article');
    card.className = 'docs-card docs-card-enter';
    card.style.animationDelay = `${indexInBatch * 80}ms`;
    card.innerHTML = `
      <div class="docs-icon">${item.icon}</div>
      <h3>${item.title}</h3>
      <p>${item.description}</p>
      <ul class="docs-links">
        ${item.links.map((link) => `<li><a href="${link.href}" target="${link.href.startsWith('http') ? '_blank' : '_self'}" rel="${link.href.startsWith('http') ? 'noopener' : ''}">${link.label}</a></li>`).join('')}
      </ul>
    `;
    return card;
  };

  const loadMoreDocs = () => {
    if (loading || nextBatchIndex >= docsQueue.length) return;
    loading = true;
    status.textContent = 'Loading more guides...';

    window.setTimeout(() => {
      const chunk = docsQueue.slice(nextBatchIndex, nextBatchIndex + 2);
      chunk.forEach((item, index) => {
        feed.appendChild(renderDocCard(item, index));
      });
      nextBatchIndex += chunk.length;
      loading = false;

      if (nextBatchIndex >= docsQueue.length) {
        status.textContent = 'All guide groups loaded. Browse the full docs for the rest.';
        sentinel.hidden = true;
      } else {
        status.textContent = 'More guides unlocked. Keep scrolling to load the next set.';
      }
    }, 320);
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) loadMoreDocs();
    });
  }, {
    rootMargin: '0px 0px 180px 0px'
  });

  observer.observe(sentinel);
}

// ── Scroll-reveal: sections start at opacity:0 in CSS, fade in on scroll ──
{
  const sections = document.querySelectorAll('section.section, .proof-bar');
  if (sections.length) {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -40px 0px' });
    sections.forEach(s => revealObserver.observe(s));
  }
}
