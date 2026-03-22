/**
 * Contacts Tab — Unified contact management across WhatsApp, Telegram, etc.
 * Deps: getJSON, postJSON (core/api), escHtml, showNotification (core/dom), state (core/state)
 */

import { getJSON, postJSON } from '../core/api.js';
import { escHtml, showNotification } from '../core/dom.js';
import { state } from '../core/state.js';

let _contactsData = {};
let _allContacts = [];
let _currentFilters = {
  search: '',
  platform: '',
  sortBy: 'name',
  letter: 'all'
};

export function showContacts() {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('contactsView').classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const nav = document.getElementById('navContacts');
  if (nav) nav.classList.add('active');
  loadContacts();
}

// ── Load contacts ─────────────────────────────────────────────────────────────

export async function loadContacts() {
  const list = document.getElementById('contactsList');
  
  list.innerHTML = '<div class="meta" style="padding:20px;">Loading contacts...</div>';
  
  try {
    const data = await getJSON('/api/contacts');
    const contacts = data.contacts || [];
    
    _contactsData = {};
    contacts.forEach(c => { _contactsData[c.contact_id] = c; });
    _allContacts = contacts;
    
    if (!contacts.length) {
      list.innerHTML = '<div class="meta" style="padding:20px;">No contacts yet. Click "+ New Contact" to add manually, or contacts are created automatically when someone messages the bot.</div>';
      document.getElementById('contactsCount').innerHTML = '';
      return;
    }
    
    applyFiltersAndRender();
    
  } catch(e) {
    list.innerHTML = '<div class="meta" style="padding:20px;color:var(--red-hi);">Failed to load contacts: ' + escHtml(e.message) + '</div>';
  }
}

// ── Filtering and Sorting ─────────────────────────────────────────────────────

export function applyContactFilters() {
  const searchInput = document.getElementById('contactsSearch');
  const platformFilter = document.getElementById('contactsPlatformFilter');
  const sortBy = document.getElementById('contactsSortBy');
  
  _currentFilters.search = searchInput.value.toLowerCase().trim();
  _currentFilters.platform = platformFilter.value;
  _currentFilters.sortBy = sortBy.value;
  
  applyFiltersAndRender();
}

export function filterByLetter(letter) {
  _currentFilters.letter = letter;
  
  // Update active button
  document.querySelectorAll('.alpha-filter').forEach(btn => {
    btn.classList.remove('active');
    btn.style.background = 'var(--bg-1)';
    btn.style.color = 'var(--text-2)';
  });
  const activeBtn = document.querySelector(`[data-letter="${letter}"]`);
  if (activeBtn) {
    activeBtn.classList.add('active');
    activeBtn.style.background = 'var(--purple)';
    activeBtn.style.color = '#fff';
  }
  
  applyFiltersAndRender();
}

function applyFiltersAndRender() {
  let filtered = [..._allContacts];
  
  // Filter by search term
  if (_currentFilters.search) {
    filtered = filtered.filter(c => {
      const searchText = `${c.display_name} ${c.phone_number || ''} ${c.email || ''} ${c.notes || ''} ${JSON.stringify(c.preferences)} ${JSON.stringify(c.tags)}`.toLowerCase();
      return searchText.includes(_currentFilters.search);
    });
  }
  
  // Filter by platform
  if (_currentFilters.platform) {
    filtered = filtered.filter(c => {
      if (c.platform === _currentFilters.platform) return true;
      const links = c.platform_links || {};
      return !!links[_currentFilters.platform];
    });
  }
  
  // Filter by letter
  if (_currentFilters.letter !== 'all') {
    filtered = filtered.filter(c => {
      const firstChar = (c.display_name || '').charAt(0).toUpperCase();
      if (_currentFilters.letter === '#') {
        return !/[A-Z]/.test(firstChar);
      }
      return firstChar === _currentFilters.letter;
    });
  }
  
  // Sort
  if (_currentFilters.sortBy === 'name') {
    filtered.sort((a, b) => {
      const nameA = (a.display_name || a.phone_number || '').toLowerCase();
      const nameB = (b.display_name || b.phone_number || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
  } else if (_currentFilters.sortBy === 'recent') {
    filtered.sort((a, b) => b.last_seen - a.last_seen);
  } else if (_currentFilters.sortBy === 'messages') {
    filtered.sort((a, b) => b.message_count - a.message_count);
  }
  
  // Update count
  const countEl = document.getElementById('contactsCount');
  if (countEl) {
    const total = _allContacts.length;
    const showing = filtered.length;
    if (showing === total) {
      countEl.innerHTML = `Showing all ${total} contacts`;
    } else {
      countEl.innerHTML = `Showing ${showing} of ${total} contacts`;
    }
  }
  
  renderContactsList(filtered);
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderContactsList(contacts) {
  const list = document.getElementById('contactsList');
  
  if (!contacts.length) {
    list.innerHTML = '<div class="meta" style="padding:20px;">No contacts match your filters.</div>';
    return;
  }
  
  list.innerHTML = contacts.map(c => {
    const id = c.contact_id;
    const safeId = escHtml(id);
    const name = escHtml(c.display_name || c.phone_number || 'Unknown');
    const platformLinks = c.platform_links || {};
    const preferences = c.preferences || {};
    const tags = c.tags || [];
    
    // Platform badges
    const platforms = [];
    if (c.platform === 'whatsapp' || platformLinks.whatsapp) platforms.push('<span style="background:#25D366;color:#fff;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">WhatsApp</span>');
    if (c.platform === 'telegram' || platformLinks.telegram) platforms.push('<span style="background:#0088cc;color:#fff;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">Telegram</span>');
    if (c.platform === 'twitter' || platformLinks.twitter) platforms.push('<span style="background:#1DA1F2;color:#fff;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">Twitter</span>');
    if (c.platform === 'instagram' || platformLinks.instagram) platforms.push('<span style="background:#E4405F;color:#fff;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">Instagram</span>');
    if (c.platform === 'tiktok' || platformLinks.tiktok) platforms.push('<span style="background:#000000;color:#fff;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">TikTok</span>');
    if (c.platform === 'slack' || platformLinks.slack) platforms.push('<span style="background:#4A154B;color:#fff;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">Slack</span>');
    if (c.platform === 'web' || platformLinks.web) platforms.push('<span style="background:#666;color:#fff;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">Web</span>');
    if (c.platform === 'website' || platformLinks.website) platforms.push('<span style="background:#666;color:#fff;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;">Website</span>');
    
    // Last seen
    const lastSeenText = formatRelativeTime(c.last_seen);
    
    // Preferences preview (compact)
    const prefPreview = [];
    if (preferences?.diet) prefPreview.push(`🍴 ${escHtml(preferences.diet)}`);
    if (preferences?.allergies?.length) prefPreview.push(`⚠️ ${escHtml(preferences.allergies.join(', '))}`);
    if (preferences?.spiceLevel) prefPreview.push(`🌶️ ${escHtml(preferences.spiceLevel)}`);
    
    // Tags
    const tagHtml = tags.length ? tags.map(t => `<span style="background:var(--bg-1);color:var(--text-3);padding:2px 6px;border-radius:4px;font-size:10px;">${escHtml(t)}</span>`).join(' ') : '';
    
    // Expandable details
    const phone = c.phone_number ? `<div><strong>Phone:</strong> ${escHtml(c.phone_number)}</div>` : '';
    const email = c.email ? `<div><strong>Email:</strong> ${escHtml(c.email)}</div>` : '';
    const notes = c.notes ? `<div style="margin-top:8px;"><strong>Notes:</strong> ${escHtml(c.notes)}</div>` : '';
    const allPrefs = preferences && Object.keys(preferences).length > 0 
      ? `<div style="margin-top:8px;"><strong>Preferences:</strong> <pre style="font-size:11px;margin-top:4px;background:var(--bg-1);padding:8px;border-radius:4px;overflow:auto;">${escHtml(JSON.stringify(preferences, null, 2))}</pre></div>`
      : '';
    
    return `
      <div class="card contact-card" id="contact-card-${safeId}" data-contact-id="${safeId}">
        <div id="contact-view-${safeId}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
            <div style="flex:1;">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
                <strong style="font-size:15px;">${name}</strong>
                ${platforms.join(' ')}
              </div>
              <div class="meta" style="font-size:12px;">
                ${c.message_count} messages · Last seen: ${lastSeenText}
              </div>
            </div>
          </div>
          
          ${prefPreview.length ? `<div style="margin-bottom:10px;font-size:12px;color:var(--text-2);">${prefPreview.join(' · ')}</div>` : ''}
          ${tagHtml ? `<div style="margin-bottom:10px;display:flex;gap:4px;flex-wrap:wrap;">${tagHtml}</div>` : ''}
          
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <button data-action="send-message" data-id="${safeId}" class="btn-green" style="font-size:12px;">💬 Send Message</button>
            <button data-action="toggle-details" data-id="${safeId}" class="btn-ghost" style="font-size:12px;">📋 Details</button>
            <button data-action="edit" data-id="${safeId}" class="btn-ghost" style="font-size:12px;">✏️ Edit</button>
            <button data-action="delete" data-id="${safeId}" style="background:transparent;color:var(--text-3);border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px;">🗑 Delete</button>
          </div>
        </div>
        
        <!-- Expandable details -->
        <div id="contact-details-${safeId}" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--border);font-size:13px;color:var(--text-2);">
          ${phone}
          ${email}
          ${notes}
          ${allPrefs}
        </div>
        
        <!-- Edit form -->
        <div id="contact-edit-${safeId}" style="display:none;padding:12px;border-top:1px solid var(--border);margin-top:12px;">
          <div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--text-3);">Display Name</label><input id="contact-name-${safeId}" type="text" value="${escHtml(c.display_name || '')}" style="margin-top:4px;width:100%;" /></div>
          <div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--text-3);">Phone</label><input id="contact-phone-${safeId}" type="text" value="${escHtml(c.phone_number || '')}" style="margin-top:4px;width:100%;" /></div>
          <div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--text-3);">Email</label><input id="contact-email-${safeId}" type="text" value="${escHtml(c.email || '')}" style="margin-top:4px;width:100%;" /></div>
          <div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--text-3);">📍 Location</label><input id="contact-location-${safeId}" type="text" value="${escHtml(c.last_location || '')}" placeholder="Grand Bend, Ontario, Canada" style="margin-top:4px;width:100%;" /></div>
          <div style="margin-bottom:12px;padding:12px;background:var(--bg-1);border-radius:6px;">
            <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:8px;font-weight:600;">🔗 Platform IDs</label>
            <div style="font-size:10px;color:var(--text-3);margin-bottom:12px;">Primary: ${escHtml(c.contact_id)}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <div><label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px;">Telegram</label><input id="platform-telegram-${safeId}" type="text" placeholder="12345678" value="${escHtml(platformLinks.telegram || '')}" style="padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);font-size:12px;width:100%;" /></div>
              <div><label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px;">WhatsApp</label><input id="platform-whatsapp-${safeId}" type="text" placeholder="1234@s.whatsapp.net" value="${escHtml(platformLinks.whatsapp || '')}" style="padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);font-size:12px;width:100%;" /></div>
              <div><label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px;">Twitter</label><input id="platform-twitter-${safeId}" type="text" placeholder="@username" value="${escHtml(platformLinks.twitter || '')}" style="padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);font-size:12px;width:100%;" /></div>
              <div><label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px;">Instagram</label><input id="platform-instagram-${safeId}" type="text" placeholder="@username" value="${escHtml(platformLinks.instagram || '')}" style="padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);font-size:12px;width:100%;" /></div>
              <div><label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px;">TikTok</label><input id="platform-tiktok-${safeId}" type="text" placeholder="@username" value="${escHtml(platformLinks.tiktok || '')}" style="padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);font-size:12px;width:100%;" /></div>
              <div><label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px;">Slack</label><input id="platform-slack-${safeId}" type="text" placeholder="U01234ABC" value="${escHtml(platformLinks.slack || '')}" style="padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);font-size:12px;width:100%;" /></div>
              <div><label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px;">Website</label><input id="platform-website-${safeId}" type="text" placeholder="https://example.com" value="${escHtml(platformLinks.website || '')}" style="padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);font-size:12px;width:100%;" /></div>
              <div><label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px;">Other</label><input id="platform-other-${safeId}" type="text" placeholder="Custom ID" value="${escHtml(platformLinks.other || '')}" style="padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);font-size:12px;width:100%;" /></div>
            </div>
          </div>
          
          <!-- Preferences Section -->
          <div style="margin-bottom:12px;padding:12px;background:var(--bg-1);border-radius:6px;">
            <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:8px;font-weight:600;">🍴 Preferences</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <div>
                <label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px;">Diet</label>
                <select id="pref-diet-${safeId}" style="padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);font-size:12px;width:100%;">
                  <option value="">None</option>
                  <option value="omnivore" ${preferences?.diet === 'omnivore' ? 'selected' : ''}>Omnivore</option>
                  <option value="vegetarian" ${preferences?.diet === 'vegetarian' ? 'selected' : ''}>Vegetarian</option>
                  <option value="vegan" ${preferences?.diet === 'vegan' ? 'selected' : ''}>Vegan</option>
                  <option value="pescatarian" ${preferences?.diet === 'pescatarian' ? 'selected' : ''}>Pescatarian</option>
                </select>
              </div>
              <div>
                <label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px;">Spice Level</label>
                <select id="pref-spice-${safeId}" style="padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);font-size:12px;width:100%;">
                  <option value="">Any</option>
                  <option value="mild" ${preferences?.spiceLevel === 'mild' ? 'selected' : ''}>Mild</option>
                  <option value="medium" ${preferences?.spiceLevel === 'medium' ? 'selected' : ''}>Medium</option>
                  <option value="hot" ${preferences?.spiceLevel === 'hot' ? 'selected' : ''}>Hot</option>
                </select>
              </div>
              <div>
                <label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px;">Budget</label>
                <select id="pref-budget-${safeId}" style="padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);font-size:12px;width:100%;">
                  <option value="">Any</option>
                  <option value="budget" ${preferences?.budget === 'budget' ? 'selected' : ''}>Budget ($)</option>
                  <option value="moderate" ${preferences?.budget === 'moderate' ? 'selected' : ''}>Moderate ($$)</option>
                  <option value="upscale" ${preferences?.budget === 'upscale' ? 'selected' : ''}>Upscale ($$$)</option>
                </select>
              </div>
              <div>
                <label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px;">Atmosphere</label>
                <select id="pref-atmosphere-${safeId}" style="padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);font-size:12px;width:100%;">
                  <option value="">Any</option>
                  <option value="quiet" ${preferences?.atmosphere === 'quiet' ? 'selected' : ''}>Quiet</option>
                  <option value="lively" ${preferences?.atmosphere === 'lively' ? 'selected' : ''}>Lively</option>
                  <option value="romantic" ${preferences?.atmosphere === 'romantic' ? 'selected' : ''}>Romantic</option>
                  <option value="family-friendly" ${preferences?.atmosphere === 'family-friendly' ? 'selected' : ''}>Family-friendly</option>
                </select>
              </div>
              <div style="grid-column:1/-1;">
                <label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px;">Allergies (comma-separated)</label>
                <input id="pref-allergies-${safeId}" type="text" placeholder="shellfish, peanuts, gluten, dairy" value="${escHtml((preferences?.allergies || []).join(', '))}" style="padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);font-size:12px;width:100%;" />
              </div>
              <div style="grid-column:1/-1;">
                <label style="font-size:10px;color:var(--text-3);display:block;margin-bottom:2px;">Favorite Cuisines (comma-separated)</label>
                <input id="pref-cuisines-${safeId}" type="text" placeholder="Thai, Mexican, Italian, Japanese" value="${escHtml((preferences?.favCuisines || []).join(', '))}" style="padding:6px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg-card);font-size:12px;width:100%;" />
              </div>
            </div>
          </div>
          
          <div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--text-3);">Notes</label><textarea id="contact-notes-${safeId}" rows="3" style="margin-top:4px;width:100%;">${escHtml(c.notes || '')}</textarea></div>
          <div style="margin-bottom:8px;"><label style="font-size:11px;color:var(--text-3);">Tags (comma-separated)</label><input id="contact-tags-${safeId}" type="text" value="${escHtml(tags.join(', '))}" style="margin-top:4px;width:100%;" /></div>
          <div style="display:flex;gap:8px;">
            <button data-action="save-edit" data-id="${safeId}" class="btn-green" style="font-size:12px;">💾 Save</button>
            <button data-action="cancel-edit" data-id="${safeId}" class="btn-ghost" style="font-size:12px;">Cancel</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ── Actions ───────────────────────────────────────────────────────────────────

export function toggleContactDetails(contactId) {
  const detailsEl = document.getElementById('contact-details-' + contactId);
  if (!detailsEl) return;
  const isVisible = detailsEl.style.display !== 'none';
  detailsEl.style.display = isVisible ? 'none' : 'block';
}

export function toggleContactEdit(contactId) {
  const viewEl = document.getElementById('contact-view-' + contactId);
  const editEl = document.getElementById('contact-edit-' + contactId);
  const detailsEl = document.getElementById('contact-details-' + contactId);
  if (!viewEl || !editEl) return;
  const isEditing = editEl.style.display !== 'none';
  viewEl.style.display = isEditing ? '' : 'none';
  editEl.style.display = isEditing ? 'none' : 'block';
  if (detailsEl) detailsEl.style.display = 'none';
}

export async function saveContactEdit(contactId) {
  const name = document.getElementById('contact-name-' + contactId)?.value?.trim();
  const phone = document.getElementById('contact-phone-' + contactId)?.value?.trim();
  const email = document.getElementById('contact-email-' + contactId)?.value?.trim();
  const location = document.getElementById('contact-location-' + contactId)?.value?.trim();
  const notes = document.getElementById('contact-notes-' + contactId)?.value?.trim();
  const tagsStr = document.getElementById('contact-tags-' + contactId)?.value?.trim();
  const tags = tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [];
  
  // Collect platform IDs from individual fields
  const platformLinks = {};
  const telegram = document.getElementById('platform-telegram-' + contactId)?.value?.trim();
  const whatsapp = document.getElementById('platform-whatsapp-' + contactId)?.value?.trim();
  const twitter = document.getElementById('platform-twitter-' + contactId)?.value?.trim();
  const instagram = document.getElementById('platform-instagram-' + contactId)?.value?.trim();
  const tiktok = document.getElementById('platform-tiktok-' + contactId)?.value?.trim();
  const slack = document.getElementById('platform-slack-' + contactId)?.value?.trim();
  const website = document.getElementById('platform-website-' + contactId)?.value?.trim();
  const other = document.getElementById('platform-other-' + contactId)?.value?.trim();
  
  if (telegram) platformLinks.telegram = telegram;
  if (whatsapp) platformLinks.whatsapp = whatsapp;
  if (twitter) platformLinks.twitter = twitter;
  if (instagram) platformLinks.instagram = instagram;
  if (tiktok) platformLinks.tiktok = tiktok;
  if (slack) platformLinks.slack = slack;
  if (website) platformLinks.website = website;
  if (other) platformLinks.other = other;
  
  // Collect preferences from form fields
  const preferences = {};
  const diet = document.getElementById('pref-diet-' + contactId)?.value?.trim();
  const spice = document.getElementById('pref-spice-' + contactId)?.value?.trim();
  const budget = document.getElementById('pref-budget-' + contactId)?.value?.trim();
  const atmosphere = document.getElementById('pref-atmosphere-' + contactId)?.value?.trim();
  const allergiesStr = document.getElementById('pref-allergies-' + contactId)?.value?.trim();
  const cuisinesStr = document.getElementById('pref-cuisines-' + contactId)?.value?.trim();
  
  if (diet) preferences.diet = diet;
  if (spice) preferences.spiceLevel = spice;
  if (budget) preferences.budget = budget;
  if (atmosphere) preferences.atmosphere = atmosphere;
  if (allergiesStr) preferences.allergies = allergiesStr.split(',').map(a => a.trim()).filter(Boolean);
  if (cuisinesStr) preferences.favCuisines = cuisinesStr.split(',').map(c => c.trim()).filter(Boolean);
  
  try {
    await postJSON('/api/contacts/update', { 
      contactId, 
      display_name: name,
      phone_number: phone,
      email,
      last_location: location,
      notes,
      tags,
      platform_links: platformLinks,
      preferences
    });
    showNotification('Contact saved');
    toggleContactEdit(contactId);
    loadContacts();
  } catch(e) {
    showNotification('Failed: ' + e.message, true);
  }
}

export async function deleteContact(contactId) {
  const contact = _contactsData[contactId];
  const name = contact ? contact.display_name : contactId;
  if (!confirm(`Delete contact "${name}"?\n\nMessage history will also be deleted.`)) return;
  
  try {
    await postJSON('/api/contacts/delete', { contactId });
    showNotification('Contact deleted');
    delete _contactsData[contactId];
    _allContacts = _allContacts.filter(c => c.contact_id !== contactId);
    applyFiltersAndRender();
  } catch(e) {
    showNotification('Failed: ' + e.message, true);
  }
}

// ── New Contact Modal ─────────────────────────────────────────────────────────

export function newContact() {
  const modal = document.getElementById('modalOverlay') || createModalOverlay();
  
  modal.innerHTML = `
    <div style="background:var(--bg-card);border-radius:12px;padding:24px;max-width:500px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
      <h3 style="margin:0 0 16px 0;">➕ New Contact</h3>
      
      <div style="margin-bottom:12px;">
        <label style="font-size:12px;color:var(--text-3);display:block;margin-bottom:4px;">Platform *</label>
        <select id="newContactPlatform" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-1);font-size:13px;">
          <option value="telegram">Telegram</option>
          <option value="whatsapp">WhatsApp</option>
          <option value="twitter">Twitter</option>
          <option value="instagram">Instagram</option>
          <option value="tiktok">TikTok</option>
          <option value="slack">Slack</option>
          <option value="website">Website</option>
          <option value="web">Web</option>
        </select>
      </div>
      
      <div style="margin-bottom:12px;">
        <label style="font-size:12px;color:var(--text-3);display:block;margin-bottom:4px;">Platform ID *</label>
        <input id="newContactId" type="text" placeholder="12345678 (Telegram), @username (Twitter/IG/TikTok), URL (Website)" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-1);font-size:13px;" />
        <div style="font-size:10px;color:var(--text-3);margin-top:4px;">
          • Telegram: chat ID (e.g., 12345678)<br>
          • WhatsApp: phone@s.whatsapp.net (e.g., 15551234567@s.whatsapp.net)<br>
          • Twitter/Instagram/TikTok: @username<br>
          • Website: URL (e.g., https://example.com)<br>
          • Slack: user ID (e.g., U01234ABC)
        </div>
      </div>
      
      <div style="margin-bottom:12px;">
        <label style="font-size:12px;color:var(--text-3);display:block;margin-bottom:4px;">Display Name *</label>
        <input id="newContactName" type="text" placeholder="John Doe" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-1);font-size:13px;" />
      </div>
      
      <div style="margin-bottom:12px;">
        <label style="font-size:12px;color:var(--text-3);display:block;margin-bottom:4px;">Phone</label>
        <input id="newContactPhone" type="text" placeholder="+1 310 905 0857" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-1);font-size:13px;" />
      </div>
      
      <div style="margin-bottom:12px;">
        <label style="font-size:12px;color:var(--text-3);display:block;margin-bottom:4px;">Email</label>
        <input id="newContactEmail" type="text" placeholder="john@example.com" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-1);font-size:13px;" />
      </div>
      
      <div style="margin-bottom:16px;">
        <label style="font-size:12px;color:var(--text-3);display:block;margin-bottom:4px;">Notes</label>
        <textarea id="newContactNotes" rows="3" placeholder="Important client, prefers morning calls..." style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-1);font-size:13px;"></textarea>
      </div>
      
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button onclick="document.getElementById('modalOverlay').style.display='none'" class="btn-ghost">Cancel</button>
        <button onclick="window.createContact()" class="btn-green">Create Contact</button>
      </div>
    </div>
  `;
  
  modal.style.display = 'flex';
}

export async function createContact() {
  const platform = document.getElementById('newContactPlatform').value;
  const platformId = document.getElementById('newContactId').value.trim();
  const displayName = document.getElementById('newContactName').value.trim();
  const phone = document.getElementById('newContactPhone').value.trim();
  const email = document.getElementById('newContactEmail').value.trim();
  const notes = document.getElementById('newContactNotes').value.trim();
  
  if (!platform || !platformId || !displayName) {
    showNotification('Platform, Platform ID, and Display Name are required', true);
    return;
  }
  
  const contactId = `${platform}:${platformId}`;
  
  try {
    await postJSON('/api/contacts/create', {
      contact_id: contactId,
      platform,
      display_name: displayName,
      phone_number: phone || null,
      email: email || null,
      notes: notes || null
    });
    showNotification('✅ Contact created');
    document.getElementById('modalOverlay').style.display = 'none';
    loadContacts();
  } catch(e) {
    showNotification('Failed: ' + e.message, true);
  }
}

// ── Send Message Modal ────────────────────────────────────────────────────────

export function showSendMessageModal(contactId) {
  const contact = _contactsData[contactId];
  if (!contact) {
    showNotification('Contact not found', true);
    return;
  }
  
  const modal = document.getElementById('modalOverlay') || createModalOverlay();
  
  const platformLinks = contact.platform_links || {};
  const hasWhatsApp = contact.platform === 'whatsapp' || platformLinks.whatsapp;
  const hasTelegram = contact.platform === 'telegram' || platformLinks.telegram;

  modal.innerHTML = `
    <div style="background:var(--bg-card);border-radius:12px;padding:24px;max-width:500px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
      <h3 style="margin:0 0 16px 0;">💬 Send Message</h3>
      <div style="margin-bottom:12px;">
        <div style="font-size:13px;color:var(--text-2);margin-bottom:8px;">To: <strong>${escHtml(contact.display_name || contact.contact_id)}</strong></div>
      </div>
      <div style="margin-bottom:12px;">
        <label style="font-size:12px;color:var(--text-3);display:block;margin-bottom:4px;">Platform</label>
        <select id="sendMessagePlatform" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-1);font-size:13px;">
          ${hasWhatsApp ? '<option value="whatsapp">WhatsApp</option>' : ''}
          ${hasTelegram ? '<option value="telegram">Telegram</option>' : ''}
          ${hasWhatsApp && hasTelegram ? '<option value="both">Both</option>' : ''}
        </select>
      </div>
      <div style="margin-bottom:16px;">
        <label style="font-size:12px;color:var(--text-3);display:block;margin-bottom:4px;">Message</label>
        <textarea id="sendMessageText" rows="4" placeholder="Your message here..." style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-1);font-size:13px;"></textarea>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button onclick="document.getElementById('modalOverlay').style.display='none'" class="btn-ghost">Cancel</button>
        <button onclick="window.sendContactMessage('${escHtml(contactId)}')" class="btn-green">Send</button>
      </div>
    </div>
  `;
  
  modal.style.display = 'flex';
}

export async function sendContactMessage(contactId) {
  const platform = document.getElementById('sendMessagePlatform').value;
  const message = document.getElementById('sendMessageText').value.trim();
  
  if (!message) {
    showNotification('Message cannot be empty', true);
    return;
  }
  
  try {
    await postJSON('/api/contacts/send', { contactId, platform, message });
    showNotification('✅ Message sent');
    document.getElementById('modalOverlay').style.display = 'none';
  } catch(e) {
    showNotification('Failed: ' + e.message, true);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function createModalOverlay() {
  let modal = document.getElementById('modalOverlay');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modalOverlay';
    modal.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999;align-items:center;justify-content:center;';
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
    document.body.appendChild(modal);
  }
  return modal;
}

function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

// ── Event Handlers ────────────────────────────────────────────────────────────

export function initContactsList() {
  document.addEventListener('click', (e) => {
    const action = e.target.getAttribute('data-action');
    const id = e.target.getAttribute('data-id');
    const letter = e.target.getAttribute('data-letter');
    
    if (action === 'toggle-details') toggleContactDetails(id);
    else if (action === 'edit') toggleContactEdit(id);
    else if (action === 'save-edit') saveContactEdit(id);
    else if (action === 'cancel-edit') toggleContactEdit(id);
    else if (action === 'delete') deleteContact(id);
    else if (action === 'send-message') showSendMessageModal(id);
    else if (action === 'newContact') newContact();
    else if (action === 'applyContactFilters') applyContactFilters();
    else if (action === 'filterByLetter') filterByLetter(letter);
    else if (action === 'loadContacts') loadContacts();
  });
  
  // Real-time search
  const searchInput = document.getElementById('contactsSearch');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      _currentFilters.search = searchInput.value.toLowerCase().trim();
      applyFiltersAndRender();
    });
  }
  
  // Platform filter change
  const platformFilter = document.getElementById('contactsPlatformFilter');
  if (platformFilter) {
    platformFilter.addEventListener('change', applyContactFilters);
  }
  
  // Sort change
  const sortBy = document.getElementById('contactsSortBy');
  if (sortBy) {
    sortBy.addEventListener('change', applyContactFilters);
  }
}

// Export to window for HTML onclick handlers
if (typeof window !== 'undefined') {
  window.loadContacts = loadContacts;
  window.searchContacts = applyContactFilters;
  window.newContact = newContact;
  window.createContact = createContact;
  window.sendContactMessage = sendContactMessage;
  window.filterByLetter = filterByLetter;
}
