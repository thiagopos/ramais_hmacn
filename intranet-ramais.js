// Função para abrir e fechar os andares //

function openCity(evt, cityName) {
  var i, tabcontent, tablinks;
  tabcontent = document.getElementsByClassName("tabcontent");
  for (i = 0; i < tabcontent.length; i++) {
    tabcontent[i].style.display = "none";
  }
  tablinks = document.getElementsByClassName("tablinks");
  for (i = 0; i < tablinks.length; i++) {
    tablinks[i].className = tablinks[i].className.replace(" active", "");
  }
  document.getElementById(cityName).style.display = "block";
  evt.currentTarget.className += " active";
}

// Função para busca de ramais TÉRREO //

function searchRamaist() {
  var input, filter, ul, li, dd, p, i;
  input = document.getElementById("myInput");
  filter = input.value.toUpperCase();
  ul = document.getElementById("myUL");
  li = ul.getElementsByTagName("li");  
  for (i = 0; i < li.length; i++) {
    p = li[i].getElementsByTagName("p")[0];
    dd = li[i].getElementsByTagName("dd")[0];    
    if (p.innerHTML.toUpperCase().indexOf(filter) > -1 || (dd && dd.innerHTML.toUpperCase().indexOf(filter) > -1)) {
      li[i].style.display = "";
      if (dd) dd.style.display = "";
    } else {
      li[i].style.display = "none";
      if (dd) dd.style.display = "none";
    }
  }
}

// Função para busca de ramais 1° ANDAR //

function searchRamais1() {
  var input, filter, ul, li, dd, p, i;
  input = document.getElementById("myInput1");
  filter = input.value.toUpperCase();
  ul = document.getElementById("myUL1");
  li = ul.getElementsByTagName("li");  
  for (i = 0; i < li.length; i++) {
    p = li[i].getElementsByTagName("p")[0];
    dd = li[i].getElementsByTagName("dd")[0];    
    if (p.innerHTML.toUpperCase().indexOf(filter) > -1 || (dd && dd.innerHTML.toUpperCase().indexOf(filter) > -1)) {
      li[i].style.display = "";
      if (dd) dd.style.display = "";
    } else {
      li[i].style.display = "none";
      if (dd) dd.style.display = "none";
    }
  }
}


// Função para busca de ramais 2° ANDAR //

function searchRamais2() {
  var input, filter, ul, li, dd, p, i;
  input = document.getElementById("myInput2");
  filter = input.value.toUpperCase();
  ul = document.getElementById("myUL2");
  li = ul.getElementsByTagName("li");  
  for (i = 0; i < li.length; i++) {
    p = li[i].getElementsByTagName("p")[0];
    dd = li[i].getElementsByTagName("dd")[0];    
    if (p.innerHTML.toUpperCase().indexOf(filter) > -1 || (dd && dd.innerHTML.toUpperCase().indexOf(filter) > -1)) {
      li[i].style.display = "";
      if (dd) dd.style.display = "";
    } else {
      li[i].style.display = "none";
      if (dd) dd.style.display = "none";
    }
  }
}

// Função para busca de ramais 3° ANDAR //

function searchRamais3() {
  var input, filter, ul, li, dd, p, i;
  input = document.getElementById("myInput3");
  filter = input.value.toUpperCase();
  ul = document.getElementById("myUL3");
  li = ul.getElementsByTagName("li");  
  for (i = 0; i < li.length; i++) {
    p = li[i].getElementsByTagName("p")[0];
    dd = li[i].getElementsByTagName("dd")[0];    
    if (p.innerHTML.toUpperCase().indexOf(filter) > -1 || (dd && dd.innerHTML.toUpperCase().indexOf(filter) > -1)) {
      li[i].style.display = "";
      if (dd) dd.style.display = "";
    } else {
      li[i].style.display = "none";
      if (dd) dd.style.display = "none";
    }
  }
}

// Função para busca de ramais 4° ANDAR //

function searchRamais4() {
  var input, filter, ul, li, dd, p, i;
  input = document.getElementById("myInput4");
  filter = input.value.toUpperCase();
  ul = document.getElementById("myUL4");
  li = ul.getElementsByTagName("li");  
  for (i = 0; i < li.length; i++) {
    p = li[i].getElementsByTagName("p")[0];
    dd = li[i].getElementsByTagName("dd")[0];    
    if (p.innerHTML.toUpperCase().indexOf(filter) > -1 || (dd && dd.innerHTML.toUpperCase().indexOf(filter) > -1)) {
      li[i].style.display = "";
      if (dd) dd.style.display = "";
    } else {
      li[i].style.display = "none";
      if (dd) dd.style.display = "none";
    }
  }
}

// Função para busca de ramais 5° ANDAR //

function searchRamais5() {
  var input, filter, ul, li, dd, p, i;
  input = document.getElementById("myInput5");
  filter = input.value.toUpperCase();
  ul = document.getElementById("myUL5");
  li = ul.getElementsByTagName("li");  
  for (i = 0; i < li.length; i++) {
    p = li[i].getElementsByTagName("p")[0];
    dd = li[i].getElementsByTagName("dd")[0];    
    if (p.innerHTML.toUpperCase().indexOf(filter) > -1 || (dd && dd.innerHTML.toUpperCase().indexOf(filter) > -1)) {
      li[i].style.display = "";
      if (dd) dd.style.display = "";
    } else {
      li[i].style.display = "none";
      if (dd) dd.style.display = "none";
    }
  }
}

// Função para busca de ramais 6° ANDAR //

function searchRamais6() {
  var input, filter, ul, li, dd, p, i;
  input = document.getElementById("myInput6");
  filter = input.value.toUpperCase();
  ul = document.getElementById("myUL6");
  li = ul.getElementsByTagName("li");  
  for (i = 0; i < li.length; i++) {
    p = li[i].getElementsByTagName("p")[0];
    dd = li[i].getElementsByTagName("dd")[0];
    if (p.innerHTML.toUpperCase().indexOf(filter) > -1 || (dd && dd.innerHTML.toUpperCase().indexOf(filter) > -1)) {
      li[i].style.display = "";
      if (dd) dd.style.display = "";
    } else {
      li[i].style.display = "none";
      if (dd) dd.style.display = "none";
    }
  }
}
