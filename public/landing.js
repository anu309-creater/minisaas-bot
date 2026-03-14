document.addEventListener('DOMContentLoaded', () => {
    // Reveal helper
    function revealVisible() {
        document.querySelectorAll('.glass-card').forEach(card => {
            const rect = card.getBoundingClientRect();
            if (rect.top < window.innerHeight - 50) {
                card.style.opacity = '1';
                card.style.transform = 'translateY(0)';
            }
        });
    }

    // Set initial hidden state and track
    document.querySelectorAll('.glass-card').forEach(card => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(20px)';
        card.style.transition = 'all 0.6s ease-out';
    });

    // Reveal cards already in viewport on load (no scroll needed)
    revealVisible();

    // Continue revealing on scroll
    window.addEventListener('scroll', revealVisible, { passive: true });
});
