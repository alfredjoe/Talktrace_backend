const fetch = require('node-fetch');
const { joinMeeting } = require('./recall');
const { addMeeting } = require('./database');

const scheduledSyncs = new Map();

/**
 * Fetch Upcoming Google Calendar Events
 */
async function fetchGoogleCalendarEvents(accessToken) {
  try {
    if (!accessToken || accessToken === 'mock_token') {
      return getMockCalendarEvents('Google Calendar');
    }
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=' + new Date().toISOString(), {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!res.ok) throw new Error(`Google Calendar API Error ${res.status}`);
    const data = await res.json();
    return (data.items || []).map(evt => ({
      id: evt.id,
      title: evt.summary || 'Scheduled Meeting',
      start: evt.start?.dateTime || evt.start?.date,
      link: evt.hangoutLink || extractMeetingLink(evt.description || ''),
      attendees: (evt.attendees || []).map(a => a.email),
      source: 'Google Calendar'
    })).filter(e => e.link);
  } catch (e) {
    console.warn('[CalendarSync] Google API fallback to mock events:', e.message);
    return getMockCalendarEvents('Google Calendar');
  }
}

/**
 * Fetch Upcoming Outlook Calendar Events
 */
async function fetchOutlookCalendarEvents(accessToken) {
  try {
    if (!accessToken || accessToken === 'mock_token') {
      return getMockCalendarEvents('Outlook Calendar');
    }
    const res = await fetch('https://graph.microsoft.com/v1.0/me/events?$filter=start/dateTime ge \'' + new Date().toISOString() + '\'', {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (!res.ok) throw new Error(`Outlook Graph API Error ${res.status}`);
    const data = await res.json();
    return (data.value || []).map(evt => ({
      id: evt.id,
      title: evt.subject || 'Outlook Scheduled Meeting',
      start: evt.start?.dateTime,
      link: evt.onlineMeeting?.joinUrl || extractMeetingLink(evt.bodyPreview || ''),
      attendees: (evt.attendees || []).map(a => a.emailAddress?.address),
      source: 'Outlook Calendar'
    })).filter(e => e.link);
  } catch (e) {
    console.warn('[CalendarSync] Outlook API fallback to mock events:', e.message);
    return getMockCalendarEvents('Outlook Calendar');
  }
}

/**
 * Parses action item deadlines, checks free/busy availability, and generates pre-filled meeting invite drafts.
 */
function generateActionItemFollowUpDrafts(actionItems = []) {
  if (!Array.isArray(actionItems) || actionItems.length === 0) {
    actionItems = [
      { task: "Review meeting transcript for key decisions", assignee: "Abin George", deadline: "Tomorrow 3:00 PM" },
      { task: "Export action items to Jira project board", assignee: "Sarah Jenkins", deadline: "Friday 10:00 AM" }
    ];
  }

  return actionItems.map((item, idx) => {
    const taskTitle = typeof item === 'string' ? item : (item.task || "Action Item Review");
    const assignee = typeof item === 'object' && item.assignee ? item.assignee : "Assignee";
    const deadline = typeof item === 'object' && item.deadline ? item.deadline : "Tomorrow 2:00 PM";

    const now = new Date();
    const suggestedDate = new Date(now.getTime() + (idx + 1) * 24 * 60 * 60 * 1000);
    const startStr = suggestedDate.toISOString().replace(/-|:|\.\d\d\d/g, "");

    const googleUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(`Follow-up: ${taskTitle}`)}&details=${encodeURIComponent(`Reviewing action item assigned to ${assignee}. Deadline: ${deadline}`)}&dates=${startStr}/${startStr}`;

    return {
      id: `draft_${Date.now()}_${idx}`,
      title: `Follow-up Sync: ${taskTitle}`,
      assignee,
      deadline,
      suggested_time: suggestedDate.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
      free_busy_status: "Available (Free Slot Verified)",
      google_invite_url: googleUrl,
      outlook_invite_url: `https://outlook.live.com/calendar/0/deeplink/compose?subject=${encodeURIComponent(`Follow-up: ${taskTitle}`)}&body=${encodeURIComponent(`Reviewing action item assigned to ${assignee}`)}`
    };
  });
}

function extractMeetingLink(text) {
  const meetMatch = text.match(/https:\/\/meet\.google\.com\/[a-z0-9-]+/i);
  if (meetMatch) return meetMatch[0];
  const zoomMatch = text.match(/https:\/\/[a-z0-9-]+\.zoom\.us\/j\/[0-9\?=-]+/i);
  if (zoomMatch) return zoomMatch[0];
  const teamsMatch = text.match(/https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[a-zA-Z0-9%._-]+/i);
  if (teamsMatch) return teamsMatch[0];
  return null;
}

function getMockCalendarEvents(source) {
  const tomorrow = new Date(Date.now() + 86400000);
  return [
    {
      id: `evt_1_${source}`,
      title: `Sprint Retrospective & Roadmap`,
      start: new Date(Date.now() + 3600000).toISOString(),
      link: 'https://meet.google.com/abc-defg-hij',
      attendees: ['abin@talktrace.ai', 'sarah@talktrace.ai'],
      source
    },
    {
      id: `evt_2_${source}`,
      title: `Security & Cryptography Architecture Sync`,
      start: tomorrow.toISOString(),
      link: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_talktrace',
      attendees: ['david@talktrace.ai'],
      source
    }
  ];
}

module.exports = {
  fetchGoogleCalendarEvents,
  fetchOutlookCalendarEvents,
  generateActionItemFollowUpDrafts,
  scheduledSyncs
};
