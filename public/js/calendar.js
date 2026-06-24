/* ═══════════════════════════════════════════════════════════════
   CALENDAR COMPONENT - Reusable Calendar with Events
   Usage: new Calendar(containerId, options)
   ═══════════════════════════════════════════════════════════════ */

class Calendar {
    constructor(containerId, options = {}) {
        this.container = document.getElementById(containerId);
        if (!this.container) {
            console.error(`Calendar container #${containerId} not found`);
            return;
        }

        this.options = {
            events: options.events || [],
            onDateClick: options.onDateClick || null,
            onEventClick: options.onEventClick || null,
            showLegend: options.showLegend !== false,
            showViewToggle: options.showViewToggle !== false,
            ...options
        };

        this.currentDate = new Date();
        this.selectedDate = null;
        this.view = 'month'; // month, week, day

        this.init();
    }

    init() {
        this.render();
        this.attachEventListeners();
    }

    render() {
        const year = this.currentDate.getFullYear();
        const month = this.currentDate.getMonth();
        const monthName = this.currentDate.toLocaleString('default', { month: 'long', year: 'numeric' });

        const html = `
            <div class="calendar-view-container">
                <div class="calendar-header">
                    <div style="display: flex; align-items: center; gap: 1rem;">
                        <h3 class="calendar-title">${monthName}</h3>
                        ${this.options.showViewToggle ? this.renderViewToggle() : ''}
                    </div>
                    <div class="calendar-nav">
                        <button class="calendar-nav-btn" data-action="prev">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="15 18 9 12 15 6"/>
                            </svg>
                        </button>
                        <button class="calendar-today-btn" data-action="today">Today</button>
                        <button class="calendar-nav-btn" data-action="next">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <polyline points="9 18 15 12 9 6"/>
                            </svg>
                        </button>
                    </div>
                </div>
                <div class="calendar-body">
                    ${this.renderWeekdays()}
                    ${this.renderDays(year, month)}
                </div>
                ${this.options.showLegend ? this.renderLegend() : ''}
            </div>
        `;

        this.container.innerHTML = html;
    }

    renderViewToggle() {
        return `
            <div class="calendar-view-toggle">
                <button class="calendar-view-btn ${this.view === 'month' ? 'active' : ''}" data-view="month">Month</button>
                <button class="calendar-view-btn ${this.view === 'week' ? 'active' : ''}" data-view="week">Week</button>
                <button class="calendar-view-btn ${this.view === 'day' ? 'active' : ''}" data-view="day">Day</button>
            </div>
        `;
    }

    renderWeekdays() {
        const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        return `
            <div class="calendar-weekdays">
                ${weekdays.map(day => `<div class="calendar-weekday">${day}</div>`).join('')}
            </div>
        `;
    }

    renderDays(year, month) {
        const firstDay = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const daysInPrevMonth = new Date(year, month, 0).getDate();
        
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let days = [];

        // Previous month days
        for (let i = firstDay - 1; i >= 0; i--) {
            const day = daysInPrevMonth - i;
            const date = new Date(year, month - 1, day);
            days.push(this.renderDay(day, date, true));
        }

        // Current month days
        for (let day = 1; day <= daysInMonth; day++) {
            const date = new Date(year, month, day);
            days.push(this.renderDay(day, date, false));
        }

        // Next month days to fill grid
        const remainingDays = 7 - (days.length % 7);
        if (remainingDays < 7) {
            for (let day = 1; day <= remainingDays; day++) {
                const date = new Date(year, month + 1, day);
                days.push(this.renderDay(day, date, true));
            }
        }

        return `<div class="calendar-days">${days.join('')}</div>`;
    }

    renderDay(day, date, otherMonth) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const isToday = date.getTime() === today.getTime();
        const isSelected = this.selectedDate && date.getTime() === this.selectedDate.getTime();
        
        const dayEvents = this.getEventsForDate(date);
        const hasEvents = dayEvents.length > 0;

        const classes = ['calendar-day'];
        if (otherMonth) classes.push('other-month');
        if (isToday) classes.push('today');
        if (isSelected) classes.push('selected');
        if (hasEvents) classes.push('has-events');

        const maxVisible = 3;
        const visibleEvents = dayEvents.slice(0, maxVisible);
        const moreCount = dayEvents.length - maxVisible;

        return `
            <div class="${classes.join(' ')}" data-date="${date.toISOString()}">
                <div class="calendar-day-number">${day}</div>
                <div class="calendar-events">
                    ${visibleEvents.map(event => `
                        <div class="calendar-event event-${event.type}" data-event-id="${event.id}" title="${event.title}">
                            ${event.title}
                        </div>
                    `).join('')}
                    ${moreCount > 0 ? `<div class="calendar-event-more">+${moreCount} more</div>` : ''}
                </div>
            </div>
        `;
    }

    renderLegend() {
        return `
            <div class="calendar-legend">
                <div class="calendar-legend-item">
                    <div class="calendar-legend-color appointment"></div>
                    <span>Appointments</span>
                </div>
                <div class="calendar-legend-item">
                    <div class="calendar-legend-color task"></div>
                    <span>Tasks</span>
                </div>
                <div class="calendar-legend-item">
                    <div class="calendar-legend-color meeting"></div>
                    <span>Meetings</span>
                </div>
                <div class="calendar-legend-item">
                    <div class="calendar-legend-color makeup"></div>
                    <span>Make-up Classes</span>
                </div>
            </div>
        `;
    }

    getEventsForDate(date) {
        return this.options.events.filter(event => {
            const eventDate = new Date(event.date);
            eventDate.setHours(0, 0, 0, 0);
            date.setHours(0, 0, 0, 0);
            return eventDate.getTime() === date.getTime();
        });
    }

    attachEventListeners() {
        // Navigation buttons
        this.container.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const action = e.currentTarget.dataset.action;
                if (action === 'prev') this.previousMonth();
                else if (action === 'next') this.nextMonth();
                else if (action === 'today') this.goToToday();
            });
        });

        // View toggle
        this.container.querySelectorAll('[data-view]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.view = e.currentTarget.dataset.view;
                this.render();
                this.attachEventListeners();
            });
        });

        // Day clicks
        this.container.querySelectorAll('.calendar-day').forEach(day => {
            day.addEventListener('click', (e) => {
                if (e.target.classList.contains('calendar-event')) return;
                
                const dateStr = day.dataset.date;
                this.selectedDate = new Date(dateStr);
                
                if (this.options.onDateClick) {
                    this.options.onDateClick(this.selectedDate);
                }
                
                this.render();
                this.attachEventListeners();
            });
        });

        // Event clicks
        this.container.querySelectorAll('.calendar-event').forEach(event => {
            event.addEventListener('click', (e) => {
                e.stopPropagation();
                const eventId = e.currentTarget.dataset.eventId;
                const eventData = this.options.events.find(ev => ev.id === eventId);
                
                if (this.options.onEventClick && eventData) {
                    this.options.onEventClick(eventData);
                }
            });
        });
    }

    previousMonth() {
        this.currentDate.setMonth(this.currentDate.getMonth() - 1);
        this.render();
        this.attachEventListeners();
    }

    nextMonth() {
        this.currentDate.setMonth(this.currentDate.getMonth() + 1);
        this.render();
        this.attachEventListeners();
    }

    goToToday() {
        this.currentDate = new Date();
        this.selectedDate = new Date();
        this.render();
        this.attachEventListeners();
    }

    addEvent(event) {
        this.options.events.push(event);
        this.render();
        this.attachEventListeners();
    }

    removeEvent(eventId) {
        this.options.events = this.options.events.filter(e => e.id !== eventId);
        this.render();
        this.attachEventListeners();
    }

    updateEvent(eventId, updates) {
        const event = this.options.events.find(e => e.id === eventId);
        if (event) {
            Object.assign(event, updates);
            this.render();
            this.attachEventListeners();
        }
    }

    getEvents() {
        return this.options.events;
    }

    setEvents(events) {
        this.options.events = events;
        this.render();
        this.attachEventListeners();
    }
}

// Export for use in modules
if (typeof module !== 'undefined' && module.exports) {
    module.exports = Calendar;
}
