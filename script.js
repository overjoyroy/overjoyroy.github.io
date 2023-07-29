
// Function to toggle the dark mode styles
function toggleDarkMode(e) {
	if (e.matches) {
	  document.body.classList.add('dark-mode');
	} else {
	  document.body.classList.remove('dark-mode');
	}
}

// Watch for changes in the prefers-color-scheme media feature
const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
darkModeQuery.addListener(toggleDarkMode);

// Initial call to set the dark mode based on the user's system settings
toggleDarkMode(darkModeQuery);






